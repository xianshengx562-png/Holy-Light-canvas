import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const host = document.getElementById('root');
if (!host) throw new Error('缺少 #root 容器');

createRoot(host).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
