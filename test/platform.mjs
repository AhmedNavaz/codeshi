// Reasons a test cannot run on this system, for `test(name, { skip }, fn)`; false where it can.

// Many tests stand in for an agent CLI with a script that starts with #!. Windows starts only programs, so it cannot
// run these stand-ins; the code they cover is the same on every system and is tested on macOS.
export const scriptCLIs = process.platform === 'win32' && 'Windows cannot start a #! script standing in for an agent CLI';

// Windows creates symbolic links only with Developer Mode on or administrator rights, so the checks that links never
// lead outside a workspace have not been run there yet. Enabling them on Windows is follow-up work for #104.
export const noSymlinks = process.platform === 'win32' && 'Symbolic link checks have not been run on Windows yet';
