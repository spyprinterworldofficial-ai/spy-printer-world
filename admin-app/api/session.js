// Lets any API module tell the app "the session is no longer valid" (disabled account, password changed
// elsewhere, expired token) so App.js can send the user back to the login screen.
let handler = null;
export const setUnauthorizedHandler = (fn) => {
  handler = fn;
};
export const notifyUnauthorized = () => {
  if (handler) handler();
};