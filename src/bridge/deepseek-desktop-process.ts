export const DEEPSEEK_HARNESS_APP_PATH = "/Applications/DeepSeek Harness.app";
const HARNESS_EXECUTABLE = `${DEEPSEEK_HARNESS_APP_PATH}/Contents/MacOS/DeepSeek Harness`;
const LEGACY_EXECUTABLE = "/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop";

/** Match actual bundle executables, not a renderer or a shell mentioning them. */
export function classifyDeepSeekDesktopProcess(command: string): "host" | "main" | "legacy" | null {
  const value = command.trim();
  if (value === HARNESS_EXECUTABLE) return "main";
  const hostCommand = `${HARNESS_EXECUTABLE} --expose-internals ${DEEPSEEK_HARNESS_APP_PATH}/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`;
  if (value === hostCommand || value.startsWith(`${hostCommand} `)) return "host";
  if (value === LEGACY_EXECUTABLE || value.startsWith(
    "/Applications/DSH Desktop.app/Contents/Frameworks/DSH Desktop Helper.app/Contents/MacOS/",
  )) return "legacy";
  return null;
}
