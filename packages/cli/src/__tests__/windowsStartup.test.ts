import { describe, it, expect } from 'vitest';
import { windowsStartupScript } from '../windowsStartup.js';

describe('windowsStartupScript', () => {
  it('starts the server quietly with the node that installed the CLI', () => {
    expect(windowsStartupScript('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\open-alive\\dist\\cli.js')).toBe(
      '@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\open-alive\\dist\\cli.js" start --no-open\r\n',
    );
  });
});
