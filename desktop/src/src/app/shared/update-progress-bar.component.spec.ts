import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { UpdateProgressBarComponent } from './update-progress-bar.component';
import { UpdateDownloadProgress } from '../models/update';

const MB = 1024 * 1024;

describe('UpdateProgressBarComponent', () => {
  let fixture: ComponentFixture<UpdateProgressBarComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [UpdateProgressBarComponent],
    }).compileComponents();
    fixture = TestBed.createComponent(UpdateProgressBarComponent);
  });

  function render(progress: UpdateDownloadProgress): HTMLElement {
    fixture.componentRef.setInput('progress', progress);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  function bar(root: HTMLElement): HTMLElement {
    const el = root.querySelector<HTMLElement>('[role="progressbar"]');
    if (!el) throw new Error('missing progressbar');
    return el;
  }

  it('shows the percent, the sizes and a bar of that width while downloading a known total', () => {
    const root = render({ downloaded: 12 * MB, total: 48 * MB, phase: 'downloading' });

    expect(root.textContent).toContain('downloading 25% (12.0 MB / 48.0 MB)');
    expect(bar(root).getAttribute('aria-valuenow')).toBe('25');
    expect(bar(root).firstElementChild?.getAttribute('style')).toContain('width: 25%');
    expect(bar(root).firstElementChild?.classList).not.toContain('animate-pulse');
  });

  it('shows the downloaded size alone and an indeterminate bar without a total', () => {
    const root = render({ downloaded: 12 * MB, total: null, phase: 'downloading' });

    expect(root.textContent).toContain('downloading 12.0 MB');
    expect(root.textContent).not.toContain('%');
    expect(bar(root).hasAttribute('aria-valuenow')).toBe(false);
    expect(bar(root).firstElementChild?.getAttribute('style')).toContain('width: 100%');
    expect(bar(root).firstElementChild?.classList).toContain('animate-pulse');
  });

  it('fills the bar and announces the restart once the installer runs', () => {
    const root = render({ downloaded: 48 * MB, total: null, phase: 'installing' });

    expect(root.textContent).toContain('installing, the app will restart...');
    expect(bar(root).getAttribute('aria-valuenow')).toBe('100');
    expect(bar(root).firstElementChild?.classList).not.toContain('animate-pulse');
  });

  it('follows a new progress value', () => {
    render({ downloaded: 12 * MB, total: 48 * MB, phase: 'downloading' });
    const root = render({ downloaded: 24 * MB, total: 48 * MB, phase: 'downloading' });

    expect(bar(root).getAttribute('aria-valuenow')).toBe('50');
    expect(root.textContent).toContain('downloading 50%');
  });
});
