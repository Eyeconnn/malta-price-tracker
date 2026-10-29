"""The renderer's network guard: a small local proxy every browser connection goes through (render.py starts it and
launches Chromium with --proxy-server pointing at it and the loopback bypass removed).

For each connection it:
- allows only the shop's own hosts (and their subdomains) on the standard ports (443 by CONNECT, 80 for plain HTTP);
  anything else, including another site's scripts, is refused;
- resolves the host once, refuses it when any address is private, loopback, link-local or otherwise not public,
  and connects to exactly the address it checked, so a DNS answer that changes in between (rebinding) cannot
  reach the local network;
- refuses WebSocket upgrades over plain HTTP (the pages we read never need them; secure WebSockets are refused by
  the page's route handler in render.py).

So redirects, WebSockets, service workers and anything else the browser sends meet the same rule at the network
layer, whatever Playwright's request routing sees. TLS stays end to end between the browser and the shop.
"""

import asyncio
import ipaddress
import socket
import sys
from typing import Callable

HEAD_MAX = 64 * 1024
IDLE_S = 120


def host_allowed(host: str, allowed: list[str]) -> bool:
    host = host.lower().rstrip(".")
    return any(host == h or host.endswith("." + h) for h in allowed)


def public_address(host: str) -> str | None:
    """The address to connect to, or None when host is, or resolves to, any address that is not public."""
    host = host.strip("[]")
    try:
        ips = [ipaddress.ip_address(host)]
    except ValueError:
        try:
            ips = [ipaddress.ip_address(i[4][0].split("%")[0]) for i in socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)]
        except OSError:
            return None
    if not ips or any(not ip.is_global or ip.is_multicast for ip in ips):
        return None
    return str(ips[0])


def is_private(host: str) -> bool:
    return public_address(host) is None


async def _pipe(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
    try:
        while True:
            data = await asyncio.wait_for(reader.read(65536), IDLE_S)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


class GuardProxy:
    def __init__(self, allowed: Callable[[], list[str]], log: Callable[[str], None] = lambda m: print(m, file=sys.stderr)):
        self.allowed = allowed
        self.log = log
        self.server: asyncio.base_events.Server | None = None
        self.refused = 0

    async def start(self) -> int:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        return self.server.sockets[0].getsockname()[1]

    async def close(self):
        if self.server:
            self.server.close()
            await self.server.wait_closed()

    async def _refuse(self, writer: asyncio.StreamWriter, why: str):
        self.refused += 1
        self.log(f"guard: refused {why}")
        try:
            writer.write(b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            await writer.drain()
        finally:
            writer.close()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), 30)
        except Exception:
            writer.close()
            return
        if len(head) > HEAD_MAX:
            return await self._refuse(writer, "an oversized request head")
        lines = head.decode("latin-1").split("\r\n")
        try:
            method, target, version = lines[0].split(" ", 2)
        except ValueError:
            return await self._refuse(writer, "a malformed request")

        if method.upper() == "CONNECT":
            host, _, port_s = target.rpartition(":")
            port = int(port_s) if port_s.isdigit() else 0
            if port != 443:
                return await self._refuse(writer, f"CONNECT to port {port_s}")
        else:
            if not target.lower().startswith("http://"):
                return await self._refuse(writer, "a non-proxy request")
            rest = target[7:]
            hostport, slash, path = rest.partition("/")
            host, _, port_s = hostport.rpartition(":") if ":" in hostport and not hostport.endswith("]") else (hostport, "", "")
            port = int(port_s) if port_s.isdigit() else 80
            if port != 80:
                return await self._refuse(writer, f"plain HTTP to port {port}")
            if any(l.lower().startswith("upgrade:") for l in lines[1:]):
                return await self._refuse(writer, f"a WebSocket upgrade to {host}")
        host = host.strip("[]").lower()

        if not host_allowed(host, self.allowed()):
            return await self._refuse(writer, f"{host} (not a shop host)")
        ip = await asyncio.to_thread(public_address, host)
        if ip is None:
            return await self._refuse(writer, f"{host} (private or unresolvable address)")
        try:
            up_reader, up_writer = await asyncio.wait_for(asyncio.open_connection(ip, port), 30)
        except Exception as e:
            self.log(f"guard: could not reach {host}: {e}")
            writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
            writer.close()
            return

        if method.upper() == "CONNECT":
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
        else:
            # origin-form request line, one request per connection (so each request gets its own host check)
            kept = [l for l in lines[1:] if l and not l.lower().startswith(("connection:", "proxy-connection:", "keep-alive:"))]
            out = f"{method} /{path if slash else ''} {version}\r\n" + "\r\n".join(kept) + "\r\nConnection: close\r\n\r\n"
            up_writer.write(out.encode("latin-1"))
            await up_writer.drain()
        await asyncio.gather(_pipe(reader, up_writer), _pipe(up_reader, writer))
