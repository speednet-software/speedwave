import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LogoComponent } from './logo.component';

describe('LogoComponent', () => {
  let fixture: ComponentFixture<LogoComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [LogoComponent] }).compileComponents();
    fixture = TestBed.createComponent(LogoComponent);
    fixture.detectChanges();
  });

  it('exposes an accessible img role and label on the host', () => {
    const host = fixture.nativeElement as HTMLElement;
    expect(host.getAttribute('role')).toBe('img');
    expect(host.getAttribute('aria-label')).toBe('Speedwave');
  });

  // Inline SVG with currentColor is what makes the mark adapt per theme and
  // survive the Tauri WebView build (no relative-URL mask, no static image).
  it('renders an inline SVG whose path uses currentColor', () => {
    const host = fixture.nativeElement as HTMLElement;
    const path = host.querySelector('svg path');
    expect(path).not.toBeNull();
    expect(path?.getAttribute('fill')).toBe('currentColor');
  });

  it('drives its color from the host text color (theme classes present)', () => {
    const host = fixture.nativeElement as HTMLElement;
    expect(host.className).toContain('dark:text-white');
    expect(host.className).toContain('text-[var(--ink)]');
  });
});
