import { describe, it, expect, beforeEach } from 'vitest';
import { ChangeDetectionStrategy, Component, signal, type WritableSignal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  ModalOverlayComponent,
  type ModalBorderColor,
  type ModalKickerColor,
} from './modal-overlay.component';

@Component({
  selector: 'app-modal-overlay-test-host',
  imports: [ModalOverlayComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-modal-overlay
      [open]="open()"
      [kicker]="kicker()"
      [kickerColor]="kickerColor()"
      [title]="title()"
      [body]="body()"
      [code]="code()"
      [note]="note()"
      [borderColor]="borderColor()"
      [primaryLabel]="primaryLabel()"
      [secondaryLabel]="secondaryLabel()"
      [testId]="testId()"
      (primary)="primaryEvents = primaryEvents + 1"
      (secondary)="secondaryEvents = secondaryEvents + 1"
      (closed)="closedEvents = closedEvents + 1"
    />
  `,
})
class TestHostComponent {
  open = signal<boolean>(true);
  kicker = signal<string>('⚠ test kicker');
  kickerColor: WritableSignal<ModalKickerColor> = signal<ModalKickerColor>('amber');
  title = signal<string>('Test title');
  body = signal<string>('Test body copy');
  code = signal<string>('');
  note = signal<string>('');
  borderColor: WritableSignal<ModalBorderColor> = signal<ModalBorderColor>('default');
  primaryLabel = signal<string>('do it');
  secondaryLabel = signal<string>('later');
  testId = signal<string>('test-overlay');

  primaryEvents = 0;
  secondaryEvents = 0;
  closedEvents = 0;
}

describe('ModalOverlayComponent', () => {
  let host: TestHostComponent;
  let fixture: ComponentFixture<TestHostComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TestHostComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TestHostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
  });

  describe('visibility', () => {
    it('renders when open() is true', () => {
      const overlay = fixture.nativeElement.querySelector('[data-testid="test-overlay"]');
      expect(overlay).not.toBeNull();
    });

    it('renders nothing when open() is false', () => {
      host.open.set(false);
      fixture.detectChanges();
      const overlay = fixture.nativeElement.querySelector('[data-testid="test-overlay"]');
      expect(overlay).toBeNull();
    });

    it('uses the supplied testId for the backdrop element', () => {
      host.testId.set('custom-id');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="custom-id"]')).not.toBeNull();
      expect(fixture.nativeElement.querySelector('[data-testid="test-overlay"]')).toBeNull();
    });
  });

  describe('content', () => {
    it('renders the kicker, title, body, primary and secondary labels', () => {
      const root = fixture.nativeElement.querySelector('[data-testid="test-overlay"]');
      expect(root.textContent).toContain('⚠ test kicker');
      expect(root.querySelector('[data-testid="modal-title"]').textContent).toContain('Test title');
      expect(root.querySelector('[data-testid="modal-body"]').textContent).toContain(
        'Test body copy'
      );
      expect(root.querySelector('[data-testid="modal-primary"]').textContent.trim()).toBe('do it');
      expect(root.querySelector('[data-testid="modal-secondary"]').textContent.trim()).toBe(
        'later'
      );
    });

    it('hides the body paragraph when body() is empty', () => {
      host.body.set('');
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('[data-testid="modal-body"]')).toBeNull();
    });

    it('renders the optional code block when supplied', () => {
      host.code.set('Error: nope\n  at line 1');
      fixture.detectChanges();
      const code = fixture.nativeElement.querySelector('[data-testid="modal-code"]');
      expect(code).not.toBeNull();
      expect(code.textContent).toContain('Error: nope');
    });

    it('renders the optional note bar when supplied', () => {
      host.note.set('estimated: ~8s · lima keeps running');
      fixture.detectChanges();
      const note = fixture.nativeElement.querySelector('[data-testid="modal-note"]');
      expect(note).not.toBeNull();
      expect(note.textContent).toContain('lima keeps running');
    });
  });

  describe('color/border variants', () => {
    it('amber kicker uses the amber palette token', () => {
      host.kickerColor.set('amber');
      fixture.detectChanges();
      const kicker = fixture.nativeElement.querySelector('.uppercase');
      expect(kicker.classList.contains('text-[var(--amber)]')).toBe(true);
    });

    it('green kicker uses the green palette token', () => {
      host.kickerColor.set('green');
      fixture.detectChanges();
      const kicker = fixture.nativeElement.querySelector('.uppercase');
      expect(kicker.classList.contains('text-[var(--green)]')).toBe(true);
    });

    it('red kicker uses the red-400 utility', () => {
      host.kickerColor.set('red');
      fixture.detectChanges();
      const kicker = fixture.nativeElement.querySelector('.uppercase');
      expect(kicker.classList.contains('text-red-400')).toBe(true);
    });

    it('default border uses line-strong class on the box', () => {
      const box = fixture.nativeElement.querySelector('[data-testid="modal-title"]')
        .parentElement as HTMLElement;
      expect(box.className).toContain('border-[var(--line-strong)]');
    });

    it('red border swaps the box border + primary button styles', () => {
      host.borderColor.set('red');
      fixture.detectChanges();
      const box = fixture.nativeElement.querySelector('[data-testid="modal-title"]')
        .parentElement as HTMLElement;
      expect(box.className).toContain('border-red-500/30');
      const primary = fixture.nativeElement.querySelector('[data-testid="modal-primary"]');
      expect(primary.className).toContain('border-red-500/50');
      expect(primary.className).toContain('text-red-300');
    });

    it('red border widens the box (480px instead of 24rem)', () => {
      host.borderColor.set('red');
      fixture.detectChanges();
      const box = fixture.nativeElement.querySelector('[data-testid="modal-title"]')
        .parentElement as HTMLElement;
      expect(box.className).toContain('w-[min(480px,calc(100vw-2rem))]');
    });
  });

  describe('events', () => {
    it('emits primary when the primary button is clicked', () => {
      const before = host.primaryEvents;
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="modal-primary"]'
      ) as HTMLButtonElement;
      btn.click();
      expect(host.primaryEvents).toBe(before + 1);
    });

    it('emits secondary when the secondary button is clicked', () => {
      const before = host.secondaryEvents;
      const btn = fixture.nativeElement.querySelector(
        '[data-testid="modal-secondary"]'
      ) as HTMLButtonElement;
      btn.click();
      expect(host.secondaryEvents).toBe(before + 1);
    });

    it('emits closed when the backdrop is clicked', () => {
      const before = host.closedEvents;
      const backdrop = fixture.nativeElement.querySelector(
        '[data-testid="test-overlay"]'
      ) as HTMLDivElement;
      // Simulate a click whose target IS the backdrop (currentTarget === target).
      backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(host.closedEvents).toBe(before + 1);
    });

    it('does NOT emit closed when the inner card receives the click', () => {
      const before = host.closedEvents;
      const inner = fixture.nativeElement.querySelector('[data-testid="modal-title"]')
        .parentElement as HTMLElement;
      inner.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(host.closedEvents).toBe(before);
    });
  });
});
