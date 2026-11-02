/** Startup-folder script that runs `open-alive start` at Windows login, without opening a browser. */
export function windowsStartupScript(nodePath: string, cliPath: string): string {
  return `@echo off\r\n"${nodePath}" "${cliPath}" start --no-open\r\n`;
}
