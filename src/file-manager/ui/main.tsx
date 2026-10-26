import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

let container = document.getElementById('root');
if (!container) {
    container = document.createElement('div');
    container.id = 'root';
    document.body.appendChild(container);
}
createRoot(container).render(<App />);
