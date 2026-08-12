import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ResizeHandleDirective } from './resize-handle.directive';

@Component({
  imports: [ResizeHandleDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      appResizeHandle
      [disabled]="disabled()"
      (resizeStart)="log.push('start')"
      (resizeBy)="deltas.push($event)"
      (resizeEnd)="log.push('end')"
      (resizeReset)="log.push('reset')"
      data-testid="handle"
    ></div>
  `,
})
class HostComponent {
  readonly disabled = signal(false);
  readonly log: string[] = [];
  readonly deltas: number[] = [];
}

describe('ResizeHandleDirective', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;
  let handle: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [HostComponent] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    const el = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '[data-testid="handle"]'
    );
    if (!el) throw new Error('handle not rendered');
    handle = el;
  });

  function pointer(type: string, clientY: number): void {
    handle.dispatchEvent(new PointerEvent(type, { clientY, button: 0, pointerId: 1 }));
  }

  // ── accessibility attributes ──────────────────────────────────────────────
  it('exposes separator semantics and is focusable', () => {
    expect(handle.getAttribute('role')).toBe('separator');
    expect(handle.getAttribute('aria-orientation')).toBe('horizontal');
    expect(handle.getAttribute('tabindex')).toBe('0');
  });

  // ── happy path — drag ─────────────────────────────────────────────────────
  it('emits start, cumulative up-positive deltas, then end', () => {
    pointer('pointerdown', 200);
    pointer('pointermove', 170); // 30px up
    pointer('pointermove', 150); // 50px up
    pointer('pointerup', 150);
    expect(host.log).toEqual(['start', 'end']);
    expect(host.deltas).toEqual([30, 50]);
  });

  // ── edge — no move events before down are ignored ─────────────────────────
  it('ignores moves that arrive without a preceding pointerdown', () => {
    pointer('pointermove', 100);
    expect(host.deltas).toEqual([]);
    expect(host.log).toEqual([]);
  });

  // ── keyboard ──────────────────────────────────────────────────────────────
  it('ArrowUp emits +keyStep, ArrowDown emits -keyStep, each a full gesture', () => {
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    expect(host.deltas).toEqual([24, -24]);
    expect(host.log).toEqual(['start', 'end', 'start', 'end']);
  });

  it('ignores keys other than the arrows', () => {
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(host.log).toEqual([]);
  });

  // ── reset ───────────────────────────────────────────────────────────────
  it('double-click emits reset', () => {
    handle.dispatchEvent(new MouseEvent('dblclick'));
    expect(host.log).toEqual(['reset']);
  });

  // ── error path — disabled suppresses every gesture ────────────────────────
  it('emits nothing while disabled', () => {
    host.disabled.set(true);
    fixture.detectChanges();
    pointer('pointerdown', 200);
    pointer('pointermove', 100);
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    handle.dispatchEvent(new MouseEvent('dblclick'));
    expect(host.log).toEqual([]);
    expect(host.deltas).toEqual([]);
  });
});
