/** The only browser-to-OS boundary; kept separate for real-page browser tests. */
export function launchNativeInvite(link) {
  window.location.assign(link)
}
