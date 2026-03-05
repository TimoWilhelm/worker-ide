import { createRoot } from 'react-dom/client';

import { App } from './app';
import './style.css';

const root = createRoot(document.querySelector('#app')!);
root.render(<App />);
