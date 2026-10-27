const BRAND_COLORS = Object.freeze({
  cyan: [88, 234, 255],
  mint: [161, 255, 241],
  lime: [197, 255, 72],
  violet: [183, 138, 255],
  warning: [240, 199, 122],
  danger: [231, 155, 145],
  muted: [120, 143, 173],
});

export function createTerminalTheme(stream, environment = process.env) {
  const disabled = Object.hasOwn(environment, 'NO_COLOR') || environment.TERM === 'dumb' || environment.FORCE_COLOR === '0';
  const forced = environment.FORCE_COLOR !== undefined && environment.FORCE_COLOR !== '0';
  const enabled = !disabled && (stream?.isTTY === true || forced);

  return Object.freeze(
    Object.fromEntries(
      Object.entries(BRAND_COLORS).map(([name, [red, green, blue]]) => [
        name,
        (value) => {
          const text = String(value);
          return enabled ? `\u001b[38;2;${red};${green};${blue}m${text}\u001b[39m` : text;
        },
      ]),
    ),
  );
}
