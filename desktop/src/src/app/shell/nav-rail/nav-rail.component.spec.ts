import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { NavRailComponent, type NavRailEntry } from './nav-rail.component';

const ENTRIES: readonly NavRailEntry[] = [
  { id: 'chat', label: 'Chat', route: '/chat', iconPath: 'M0 0', shortcut: '⌘1' },
  { id: 'integrations', label: 'Integrations', route: '/integrations', iconPath: 'M0 0' },
  { id: 'settings', label: 'Settings', route: '/settings', iconPath: 'M0 0' },
];

@Component({
  imports: [NavRailComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-nav-rail
      [entries]="entries()"
      [activeId]="activeId()"
      (paletteOpened)="opens = opens + 1"
    />
  `,
})
class HostComponent {
  readonly entries = signal<readonly NavRailEntry[]>(ENTRIES);
  readonly activeId = signal('chat');
  opens = 0;
}

describe('NavRailComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        provideRouter([
          { path: 'chat', children: [] },
          { path: 'integrations', children: [] },
          { path: 'settings', children: [] },
        ]),
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  // Happy path
  it('renders one button per entry inside data-testid="nav-rail"', () => {
    const buttons = fixture.nativeElement.querySelectorAll('a[data-testid^="nav-"]');
    expect(buttons.length).toBe(3);
  });

  it('marks the active entry with .active and aria-current="page"', () => {
    const active = fixture.nativeElement.querySelector('[data-testid="nav-chat"]');
    const inactive = fixture.nativeElement.querySelector('[data-testid="nav-settings"]');
    expect(active.classList.contains('active')).toBe(true);
    expect(active.getAttribute('aria-current')).toBe('page');
    expect(inactive.classList.contains('active')).toBe(false);
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('does not render hover tooltips on rail entries', () => {
    // The hover tooltip with the shortcut hint was removed — the rail
    // surface is intentionally minimal (mockup-aligned) and the keyboard
    // shortcuts live in the command palette.
    const tip = fixture.nativeElement.querySelector('[data-testid="nav-chat"] .tooltip');
    expect(tip).toBeNull();
    const tipKbd = fixture.nativeElement.querySelector('[data-testid="nav-integrations"] .tooltip');
    expect(tipKbd).toBeNull();
  });

  // Edge cases
  it('renders nothing in the nav when entries is empty', () => {
    host.entries.set([]);
    fixture.detectChanges();
    const buttons = fixture.nativeElement.querySelectorAll('[data-testid="nav-rail"] a');
    expect(buttons.length).toBe(0);
  });

  it('falls back to no active button when activeId matches nothing', () => {
    host.activeId.set('nope');
    fixture.detectChanges();
    const all = fixture.nativeElement.querySelectorAll('a[data-testid^="nav-"]');
    for (const a of all) {
      expect(a.classList.contains('active')).toBe(false);
    }
  });

  // ARIA
  it('exposes role="navigation" and aria-label="Primary" on the host', () => {
    const el =
      fixture.debugElement.nativeElement.querySelector('app-nav-rail') ??
      fixture.debugElement.nativeElement;
    expect(el.getAttribute('role')).toBe('navigation');
    expect(el.getAttribute('aria-label')).toBe('Primary');
  });

  // Output
  it('emits paletteOpened when the palette trigger is clicked', () => {
    const trigger = fixture.nativeElement.querySelector(
      '[data-testid="nav-rail-palette"]'
    ) as HTMLButtonElement;
    trigger.click();
    fixture.detectChanges();
    expect(host.opens).toBe(1);
  });
});
