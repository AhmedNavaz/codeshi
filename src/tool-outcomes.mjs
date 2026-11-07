// Command inputs are not results. New events carry a native outcome; old journals only qualify when
// their output contains a recognizable failure diagnostic. A successful native result always wins.
export function commandOutcome(message) {
  const lines = String(message?.text || '').split('\n');
  let command, output;
  if (lines[0].startsWith('$ ')) { command = lines[0].slice(2); output = lines.slice(1).join('\n'); }
  else if (/^(Bash|shell|execute|run_shell_command)$/.test(lines[0])) {
    try { command = JSON.parse(lines[1]).command; } catch { return null; }
    output = lines.slice(2).join('\n');
  }
  if (!command) return null;
  const native = message.toolOutcome;
  const failed = native ? native.status === 'completed' && (native.isError === true || typeof native.exitCode === 'number' && native.exitCode !== 0)
    : /^(?:fatal:|Error:|[\w.]+Error:|Traceback \(most recent call last\):|(?:\S*\/)?(?:ba|z|da)?sh:.*(?:command not found|no such file|permission denied)|# fail [1-9]\d*\b|\s*Exit code[: ]+[1-9]\d*\b|\s*Process exited with code [1-9]\d*\b|\s*\d+ (?:tests? )?(?:failed|failing)\b)/im.test(output);
  return { command, output, failed, completed: native?.status === 'completed', exitCode: native?.exitCode };
}
