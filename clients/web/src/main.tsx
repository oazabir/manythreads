import { createRoot } from 'react-dom/client';
import './styles/tokens.css';
import './styles/app.css';
import './styles/screens.css';
import { configureApi } from './api/setup';
import { App } from './App';

configureApi();

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
