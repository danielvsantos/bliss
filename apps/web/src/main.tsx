import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import "./i18n";
import { Providers } from "./lib/providers.tsx";

console.log(
  '%c💜 Welcome to bliss%c\nThe quiet intelligence behind your global wealth.\n\nLike what you see? We\'re open source!\nGive us a ⭐ and help us grow → %cgithub.com/danielvsantos/bliss',
  'color:#ffffff;font-size:20px;font-weight:700;',
  'color:#ffffff;font-size:13px;line-height:1.7;',
  'color:#B8AEC8;font-size:13px;text-decoration:underline;'
);


createRoot(document.getElementById("root")!).render(
<Providers>
    <App />
</Providers>
);


