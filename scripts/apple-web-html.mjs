// Keep native Apple storage in the browser workspace while using the hosted
// Noteject service for accounts, sync, and metered AI requests.
export function prepareAppleHtml(html) {
  if (!html.includes('<base href="/app/">')) {
    throw new Error('The hosted app base path was not found; refusing to create a broken Apple app.');
  }
  return html
    .replace('<base href="/app/">', '<base href="./">')
    .replace('</head>', '<script>if(location.protocol==="capacitor:"&&location.hostname==="localhost"){window.NotejectAppleNative=true;window.NotejectWebApp=true;window.NOTEJECT_CLOUD_ORIGIN="https://noteject.vercel.app";document.documentElement.classList.add("noteject-web","noteject-ios");}</script></head>');
}
