// Chrome cannot show the microphone prompt inside the side panel, so the
// side panel opens this page once; the permission then applies to it too.
import "./plain-page-fonts";
const statusLine = document.getElementById("status");

navigator.mediaDevices
  .getUserMedia({ audio: true })
  .then((stream) => {
    stream.getTracks().forEach((track) => track.stop());
    if (statusLine) {
      statusLine.textContent =
        "Microphone allowed. You can close this tab and press the microphone button in BrowserHarness again.";
    }
  })
  .catch(() => {
    if (statusLine) {
      statusLine.textContent =
        "The microphone is blocked. Click the icon at the left of the address bar, allow the microphone, then reload this page.";
    }
  });
export {};
