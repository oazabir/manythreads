import { createRoot } from 'react-dom/client';
import './styles/tokens.css';

const root = document.getElementById('root');
if (root) createRoot(root).render(<div data-testid="app-frame" />);
