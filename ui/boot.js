// Runs before the first paint (tiny, blocking): enables JS-only styles and marks repeat visits, so the preloader
// shows once and never again.
const root = document.documentElement;
root.classList.add("js");
try {
  if (localStorage.getItem("crawler-free-seen")) root.classList.add("seen");
} catch {
  root.classList.add("seen"); // storage blocked: skip the preloader rather than show it every time
}
