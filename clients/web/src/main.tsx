import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/app.css';
import './styles/screens.css';
import './styles/shell.css';
import './styles/channels.css';
import './styles/discover.css';
import './styles/viewers.css';
import './styles/files.css';
import { configureApi } from './api/setup';
import { App } from './App';

configureApi();

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
