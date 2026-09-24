import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EffortSliderComponent, capitalizeLevel } from './effort-slider.component';

const FULL_STOPS = ['low', 'medium', 'high', 'xhigh', 'max'];
const NO_XHIGH_STOPS = ['low', 'medium', 'high', 'max'];

describe('capitalizeLevel', () => {
  it('capitalizes only the first letter', () => {
    expect(capitalizeLevel('low')).toBe('Low');
    expect(capitalizeLevel('xhigh')).toBe('Xhigh');
    expect(capitalizeLevel('max')).toBe('Max');
    expect(capitalizeLevel('')).toBe('');
  });
});

describe('EffortSliderComponent', () => {
  let fixture: ComponentFixture<EffortSliderComponent>;

  function setInputs(stops: string[], activeLevel: string, pinned = true): void {
    fixture.componentRef.setInput('stops', stops);
    fixture.componentRef.setInput('activeLevel', activeLevel);
    fixture.componentRef.setInput('pinned', pinned);
    fixture.detectChanges();
  }

  function slider(): HTMLElement {
    return fixture.nativeElement.querySelector('[data-testid="effort-slider"]') as HTMLElement;
  }

  function stopEl(level: string): HTMLElement {
    return fixture.nativeElement.querySelector(
      `[data-testid="effort-stop-${level}"]`
    ) as HTMLElement;
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [EffortSliderComponent] }).compileComponents();
    fixture = TestBed.createComponent(EffortSliderComponent);
  });

  it('renders exactly the given stops, in order, restricted to the active model', () => {
    setInputs(NO_XHIGH_STOPS, 'high');
    for (const level of NO_XHIGH_STOPS) expect(stopEl(level)).toBeTruthy();
    expect(fixture.nativeElement.querySelector('[data-testid="effort-stop-xhigh"]')).toBeFalsy();
  });

  it('shows the level in the header when pinned', () => {
    setInputs(FULL_STOPS, 'high', true);
    const header = fixture.nativeElement.querySelector('[data-testid="effort-popover-header"]');
    expect(header.textContent).toContain('Effort High');
  });

  it('shows Default and a dimmed handle when unpinned', () => {
    setInputs(FULL_STOPS, 'high', false);
    const header = fixture.nativeElement.querySelector('[data-testid="effort-popover-header"]');
    expect(header.textContent).toContain('Effort Default');
    expect(slider().className).toContain('opacity-40');
  });

  it('shows Faster/Smarter labels and no help icon', () => {
    setInputs(FULL_STOPS, 'high');
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Faster');
    expect(text).toContain('Smarter');
    expect(fixture.nativeElement.querySelector('[aria-label="Help"]')).toBeFalsy();
    expect(text).not.toContain('?');
  });

  it('exposes role=slider with numeric bounds and a textual value', () => {
    setInputs(FULL_STOPS, 'xhigh');
    const el = slider();
    expect(el.getAttribute('role')).toBe('slider');
    expect(el.getAttribute('aria-valuemin')).toBe('0');
    expect(el.getAttribute('aria-valuemax')).toBe('4');
    expect(el.getAttribute('aria-valuenow')).toBe('3');
    expect(el.getAttribute('aria-valuetext')).toBe('Xhigh');
  });

  it('ArrowRight/ArrowLeft move the tentative stop without emitting', () => {
    setInputs(FULL_STOPS, 'medium');
    const emitted: string[] = [];
    fixture.componentInstance.levelSelected.subscribe((l) => emitted.push(l));

    slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    fixture.detectChanges();
    expect(slider().getAttribute('aria-valuetext')).toBe('High');
    expect(emitted).toEqual([]);

    slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    fixture.detectChanges();
    expect(slider().getAttribute('aria-valuetext')).toBe('Medium');
    expect(emitted).toEqual([]);
  });

  it('Enter commits the tentative stop reached by arrow keys', () => {
    setInputs(FULL_STOPS, 'medium');
    const emitted: string[] = [];
    fixture.componentInstance.levelSelected.subscribe((l) => emitted.push(l));

    slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();
    expect(emitted).toEqual(['xhigh']);
  });

  it('clamps arrow movement at the first and last stop', () => {
    setInputs(NO_XHIGH_STOPS, 'low');
    slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    fixture.detectChanges();
    expect(slider().getAttribute('aria-valuenow')).toBe('0');

    setInputs(NO_XHIGH_STOPS, 'max');
    slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    fixture.detectChanges();
    expect(slider().getAttribute('aria-valuenow')).toBe('3');
  });

  it('ignores keys other than the arrows and Enter', () => {
    setInputs(FULL_STOPS, 'medium');
    const emitted: string[] = [];
    fixture.componentInstance.levelSelected.subscribe((l) => emitted.push(l));
    slider().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();
    expect(emitted).toEqual([]);
    expect(slider().getAttribute('aria-valuetext')).toBe('Medium');
  });

  it('clicking a stop emits it immediately', () => {
    setInputs(FULL_STOPS, 'medium');
    const emitted: string[] = [];
    fixture.componentInstance.levelSelected.subscribe((l) => emitted.push(l));
    stopEl('max').click();
    fixture.detectChanges();
    expect(emitted).toEqual(['max']);
  });

  it('a drag applies the nearest stop only on pointerup, not on intermediate moves', () => {
    setInputs(FULL_STOPS, 'low');
    const emitted: string[] = [];
    fixture.componentInstance.levelSelected.subscribe((l) => emitted.push(l));

    const track = fixture.nativeElement.querySelector('.relative') as HTMLElement;
    const rect = {
      left: 0,
      width: 100,
      top: 0,
      height: 16,
      right: 100,
      bottom: 16,
      x: 0,
      y: 0,
      toJSON: () => rect,
    };
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(rect);

    const handle = slider();
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 75, pointerId: 1 }));
    fixture.detectChanges();
    expect(emitted).toEqual([]);
    expect(handle.getAttribute('aria-valuetext')).toBe('Xhigh');

    handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 75, pointerId: 1 }));
    fixture.detectChanges();
    expect(emitted).toEqual(['xhigh']);
  });

  function mockTrackRect(): void {
    const track = fixture.nativeElement.querySelector('.relative') as HTMLElement;
    const rect = {
      left: 0,
      width: 100,
      top: 0,
      height: 16,
      right: 100,
      bottom: 16,
      x: 0,
      y: 0,
      toJSON: () => rect,
    };
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(rect);
  }

  it('a cancelled drag commits nothing, even on a later hover and pointerup', () => {
    setInputs(FULL_STOPS, 'low');
    const emitted: string[] = [];
    fixture.componentInstance.levelSelected.subscribe((l) => emitted.push(l));
    mockTrackRect();

    const handle = slider();
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 75, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, pointerId: 1 }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(handle.getAttribute('aria-valuetext')).toBe('Low');
  });

  it('an input change mid-drag ends the drag, so the release commits nothing', () => {
    setInputs(FULL_STOPS, 'low');
    const emitted: string[] = [];
    fixture.componentInstance.levelSelected.subscribe((l) => emitted.push(l));
    mockTrackRect();

    const handle = slider();
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, pointerId: 1 }));
    fixture.detectChanges();
    expect(handle.getAttribute('aria-valuetext')).toBe('Max');

    fixture.componentRef.setInput('activeLevel', 'medium');
    fixture.detectChanges();
    handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, pointerId: 1 }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(handle.getAttribute('aria-valuetext')).toBe('Medium');
  });

  it('pointermove without a preceding pointerdown is ignored', () => {
    setInputs(FULL_STOPS, 'low');
    const track = fixture.nativeElement.querySelector('.relative') as HTMLElement;
    const rect = {
      left: 0,
      width: 100,
      top: 0,
      height: 16,
      right: 100,
      bottom: 16,
      x: 0,
      y: 0,
      toJSON: () => rect,
    };
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue(rect);
    slider().dispatchEvent(new PointerEvent('pointermove', { clientX: 90, pointerId: 1 }));
    fixture.detectChanges();
    expect(slider().getAttribute('aria-valuetext')).toBe('Low');
  });

  it('falls back to the first stop when activeLevel is not one of the stops', () => {
    setInputs(NO_XHIGH_STOPS, 'xhigh');
    expect(slider().getAttribute('aria-valuenow')).toBe('0');
  });

  it('ignores a non-primary button press: a following move over the track leaves the level unchanged and emits nothing', () => {
    setInputs(FULL_STOPS, 'low');
    const emitted: string[] = [];
    fixture.componentInstance.levelSelected.subscribe((l) => emitted.push(l));
    mockTrackRect();

    const handle = slider();
    handle.dispatchEvent(new PointerEvent('pointerdown', { clientX: 0, button: 2, pointerId: 1 }));
    handle.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, pointerId: 1 }));
    fixture.detectChanges();
    expect(handle.getAttribute('aria-valuetext')).toBe('Low');

    handle.dispatchEvent(new PointerEvent('pointerup', { clientX: 100, pointerId: 1 }));
    fixture.detectChanges();
    expect(emitted).toEqual([]);
  });
});
