import { describe, it, expect } from 'vitest';
import { UpdateDownloadProgress, downloadProgressPercent, downloadProgressText } from './update';

function downloading(downloaded: number, total: number | null): UpdateDownloadProgress {
  return { downloaded, total, phase: 'downloading' };
}

describe('downloadProgressPercent', () => {
  it('rounds the ratio down to a whole percent', () => {
    expect(downloadProgressPercent(downloading(1_999, 10_000))).toBe(19);
  });

  it('is null while the server has not sent a total', () => {
    expect(downloadProgressPercent(downloading(5_000, null))).toBeNull();
  });

  it('is null for a zero total instead of dividing by it', () => {
    expect(downloadProgressPercent(downloading(5_000, 0))).toBeNull();
  });

  it('caps at 100 when more bytes arrive than announced', () => {
    expect(downloadProgressPercent(downloading(12_000, 10_000))).toBe(100);
  });

  it('is 0 before the first byte', () => {
    expect(downloadProgressPercent(downloading(0, 10_000))).toBe(0);
  });

  it('is 100 once the installer runs, whatever the total', () => {
    expect(downloadProgressPercent({ downloaded: 7, total: null, phase: 'installing' })).toBe(100);
  });
});

describe('downloadProgressText', () => {
  it('shows percent and both sizes while downloading a known total', () => {
    expect(downloadProgressText(downloading(12 * 1024 * 1024, 48 * 1024 * 1024))).toBe(
      'downloading 25% (12.0 MB / 48.0 MB)'
    );
  });

  it('shows only the downloaded size without a total', () => {
    expect(downloadProgressText(downloading(12 * 1024 * 1024, null))).toBe('downloading 12.0 MB');
  });

  it('announces the restart once the installer runs', () => {
    expect(
      downloadProgressText({ downloaded: 48 * 1024 * 1024, total: null, phase: 'installing' })
    ).toBe('installing, the app will restart...');
  });
});
