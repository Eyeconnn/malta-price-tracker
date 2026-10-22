import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ModeProvider } from './components/site/ModeProvider';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ModeProvider>
      <App />
    </ModeProvider>
  </StrictMode>,
);
