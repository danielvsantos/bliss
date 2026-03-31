import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import "./i18n"; // 
import { Providers } from "./lib/providers.tsx";


createRoot(document.getElementById("root")!).render(
<Providers>
    <App />
</Providers>
);


