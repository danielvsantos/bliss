import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import "./i18n";
import { Providers } from "./lib/providers.tsx";
// Side effect: capture beforeinstallprompt before React mounts (#155).
import "./lib/pwa/install-prompt";
import { registerPwa } from "./lib/pwa/register";
import { installVisualViewportVars } from "./lib/pwa/visual-viewport";

console.log(
  '%c💜 Welcome to bliss%c\nThe quiet intelligence behind your global wealth.\n\nLike what you see? We\'re open source!\nGive us a ⭐ and help us grow → %cgithub.com/danielvsantos/bliss',
  'color-scheme:light dark;color:light-dark(#3A3542,#ffffff);font-size:20px;font-weight:700;',
  'color-scheme:light dark;color:light-dark(#3A3542,#ffffff);font-size:13px;line-height:1.7;',
  'color-scheme:light dark;color:light-dark(#6D657A,#B8AEC8);font-size:13px;text-decoration:underline;'
);


// Keyboard-aware dialog sizing (#155): --vv-height / --vv-top on <html>.
installVisualViewportVars();

// The service worker exists only in production builds (vite-plugin-pwa).
if (import.meta.env.PROD) {
  registerPwa();
}

createRoot(document.getElementById("root")!).render(
<Providers>
    <App />
</Providers>
);


