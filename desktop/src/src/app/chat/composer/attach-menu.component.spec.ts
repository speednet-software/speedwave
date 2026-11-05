import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AttachMenuComponent, type PickedFiles } from './attach-menu.component';
import { IMAGE_MEDIA_TYPES } from '../../models/chat';

describe('AttachMenuComponent', () => {
  let fixture: ComponentFixture<AttachMenuComponent>;
  let rootEl: HTMLElement;
  let emitted: PickedFiles[];
  let dialogOpened: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [AttachMenuComponent] }).compileComponents();
    fixture = TestBed.createComponent(AttachMenuComponent);
    rootEl = fixture.nativeElement as HTMLElement;
    emitted = [];
    fixture.componentInstance.picked.subscribe((p) => emitted.push(p));
    fixture.detectChanges();
    dialogOpened = vi.fn<() => void>();
    picker().click = dialogOpened;
  });

  function trigger(): HTMLButtonElement {
    const el = rootEl.querySelector<HTMLButtonElement>('[data-testid="composer-attach"]');
    if (!el) throw new Error('attach button not rendered');
    return el;
  }

  function picker(): HTMLInputElement {
    const el = rootEl.querySelector<HTMLInputElement>('[data-testid="composer-file-picker"]');
    if (!el) throw new Error('file input not rendered');
    return el;
  }

  function menu(): HTMLElement | null {
    return document.querySelector<HTMLElement>('[data-testid="composer-attach-menu"]');
  }

  function menuItem(testId: string): HTMLButtonElement {
    const el = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!el) throw new Error(`${testId} not rendered`);
    return el;
  }

  function openMenu(): void {
    trigger().click();
    fixture.detectChanges();
  }

  function chooseItem(testId: 'composer-attach-files' | 'composer-attach-images'): void {
    openMenu();
    menuItem(testId).click();
    fixture.detectChanges();
  }

  function keydown(el: HTMLElement, key: string, keyCode: number): void {
    el.dispatchEvent(new KeyboardEvent('keydown', { key, keyCode, bubbles: true }));
    fixture.detectChanges();
  }

  function dialogReturns(files: File[]): { valueReset: boolean } {
    const input = picker();
    let value = 'C:\\fakepath\\picked';
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => value,
      set: (v: string) => {
        value = v;
      },
    });
    input.dispatchEvent(new Event('change'));
    return { valueReset: value === '' };
  }

  const png = (): File => new File(['p'], 'shot.png', { type: 'image/png' });
  const pdf = (): File => new File(['%PDF'], 'notes.pdf', { type: 'application/pdf' });
  const heic = (): File => new File(['h'], 'IMG_0001.heic', { type: 'image/heic' });

  describe('trigger', () => {
    it('renders an enabled "+" with an accessible name and a closed menu', () => {
      expect(trigger().getAttribute('aria-label')).toBe('Add attachment');
      expect(trigger().disabled).toBe(false);
      expect(trigger().getAttribute('aria-expanded')).toBe('false');
      expect(menu()).toBeNull();
    });

    it('is disabled while the composer is disabled', () => {
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();

      expect(trigger().disabled).toBe(true);
    });

    it('opens a menu with both items and the drop/paste hint', () => {
      openMenu();

      expect(trigger().getAttribute('aria-expanded')).toBe('true');
      expect(menuItem('composer-attach-files').textContent?.trim()).toBe('Attach files…');
      expect(menuItem('composer-attach-images').textContent?.trim()).toBe('Attach images…');
      expect(menu()?.textContent).toContain(
        'You can also drop files on the message box or paste them.'
      );
    });
  });

  describe('keyboard', () => {
    it('opens on ArrowDown with focus on the first item', () => {
      trigger().focus();
      keydown(trigger(), 'ArrowDown', 40);

      expect(menu()).not.toBeNull();
      expect(document.activeElement).toBe(menuItem('composer-attach-files'));
    });

    it('closes on Escape and returns focus to the "+"', () => {
      trigger().focus();
      keydown(trigger(), 'ArrowDown', 40);

      keydown(menuItem('composer-attach-files'), 'Escape', 27);

      expect(menu()).toBeNull();
      expect(document.activeElement).toBe(trigger());
    });

    it('opens the dialog with Enter on an item and closes the menu', () => {
      trigger().focus();
      keydown(trigger(), 'ArrowDown', 40);
      keydown(document.activeElement as HTMLElement, 'ArrowDown', 40);

      keydown(menuItem('composer-attach-images'), 'Enter', 13);

      expect(dialogOpened).toHaveBeenCalledOnce();
      expect(picker().accept).toBe(IMAGE_MEDIA_TYPES.join(','));
      expect(menu()).toBeNull();
    });
  });

  describe('Attach files…', () => {
    it('opens a multi-select dialog without a type filter and closes the menu', () => {
      chooseItem('composer-attach-files');

      expect(dialogOpened).toHaveBeenCalledOnce();
      expect(picker().accept).toBe('');
      expect(picker().multiple).toBe(true);
      expect(menu()).toBeNull();
    });

    it('emits every picked file, images included, with no notice', () => {
      chooseItem('composer-attach-files');

      dialogReturns([pdf(), png(), heic()]);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].files.map((f) => f.name)).toEqual([
        'notes.pdf',
        'shot.png',
        'IMG_0001.heic',
      ]);
      expect(emitted[0].notices).toEqual([]);
    });
  });

  describe('Attach images…', () => {
    it('opens the dialog filtered to the image types the image pipeline takes', () => {
      chooseItem('composer-attach-images');

      expect(dialogOpened).toHaveBeenCalledOnce();
      expect(picker().accept).toBe(IMAGE_MEDIA_TYPES.join(','));
    });

    it('keeps the images and names in one notice what the dialog let through but is not one', () => {
      chooseItem('composer-attach-images');

      dialogReturns([png(), pdf(), heic()]);

      expect(emitted).toHaveLength(1);
      expect(emitted[0].files.map((f) => f.name)).toEqual(['shot.png']);
      expect(emitted[0].notices).toEqual([
        'Only images can be attached with Attach images…: notes.pdf, IMG_0001.heic',
      ]);
    });

    it('emits only the notice when nothing picked is an image', () => {
      chooseItem('composer-attach-images');

      dialogReturns([pdf()]);

      expect(emitted).toEqual([
        { files: [], notices: ['Only images can be attached with Attach images…: notes.pdf'] },
      ]);
    });

    it('drops the filter and the check again for the next "Attach files…"', () => {
      chooseItem('composer-attach-images');
      chooseItem('composer-attach-files');

      dialogReturns([pdf()]);

      expect(picker().accept).toBe('');
      expect(emitted[0].files.map((f) => f.name)).toEqual(['notes.pdf']);
      expect(emitted[0].notices).toEqual([]);
    });
  });

  describe('dialog result', () => {
    it('clears the input after every pick so the same file can be picked again', () => {
      chooseItem('composer-attach-files');

      const first = dialogReturns([pdf()]);
      const second = dialogReturns([pdf()]);

      expect(first.valueReset).toBe(true);
      expect(second.valueReset).toBe(true);
      expect(emitted).toHaveLength(2);
    });

    it('emits nothing when the dialog was cancelled', () => {
      chooseItem('composer-attach-files');

      dialogReturns([]);

      expect(emitted).toEqual([]);
    });

    it('cannot open the menu or the dialog while disabled', () => {
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();

      trigger().click();
      fixture.detectChanges();

      expect(menu()).toBeNull();
      expect(dialogOpened).not.toHaveBeenCalled();
    });

    it('does not open the dialog when the composer was disabled while the menu was open', () => {
      openMenu();
      fixture.componentRef.setInput('disabled', true);
      fixture.detectChanges();

      menuItem('composer-attach-files').click();

      expect(dialogOpened).not.toHaveBeenCalled();
    });
  });
});
