import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Terminal root element is missing.');
createRoot(container).render(<App />);
