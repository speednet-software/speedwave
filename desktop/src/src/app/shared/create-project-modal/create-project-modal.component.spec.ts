import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CreateProjectModalComponent } from './create-project-modal.component';
import { TauriService } from '../../services/tauri.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
import { open } from '@tauri-apps/plugin-dialog';
const openMock = vi.mocked(open);

describe('CreateProjectModalComponent', () => {
  let component: CreateProjectModalComponent;
  let fixture: ComponentFixture<CreateProjectModalComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    openMock.mockReset();

    await TestBed.configureTestingModule({
      imports: [CreateProjectModalComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(CreateProjectModalComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('open', true);
    fixture.detectChanges();
  });

  describe('rendering (happy path)', () => {
    it('renders the modal when `open` is true', () => {
      expect(
        fixture.nativeElement.querySelector('[data-testid="create-project-modal"]')
      ).not.toBeNull();
    });

    it('omits the modal entirely when `open` is false', () => {
      fixture.componentRef.setInput('open', false);
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="create-project-modal"]')
      ).toBeNull();
    });

    it('renders the cancel button only when `dismissible` is true (default)', () => {
      expect(
        fixture.nativeElement.querySelector('[data-testid="create-project-cancel"]')
      ).not.toBeNull();
    });

    it('hides the cancel button when `dismissible` is false', () => {
      fixture.componentRef.setInput('dismissible', false);
      fixture.detectChanges();
      expect(
        fixture.nativeElement.querySelector('[data-testid="create-project-cancel"]')
      ).toBeNull();
    });

    it('disables the submit button until both dir and name are present', () => {
      const submit = fixture.nativeElement.querySelector(
        '[data-testid="create-project-submit"]'
      ) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
    });
  });

  describe('browse() — folder picker', () => {
    it('updates dir and auto-fills the name on a fresh selection', async () => {
      openMock.mockResolvedValue('/Users/me/projects/Acme Corp');
      await component.browse();
      fixture.detectChanges();

      const dirInput = fixture.nativeElement.querySelector(
        '[data-testid="create-project-dir"]'
      ) as HTMLInputElement;
      const nameInput = fixture.nativeElement.querySelector(
        '[data-testid="create-project-name"]'
      ) as HTMLInputElement;
      expect(dirInput.value).toBe('/Users/me/projects/Acme Corp');
      expect(nameInput.value).toBe('acme-corp');
    });

    it('preserves a manually edited name when the user picks another folder', async () => {
      openMock.mockResolvedValueOnce('/Users/me/projects/first');
      await component.browse();
      fixture.detectChanges();

      // User overrides the auto-filled name.
      component.onNameInput({ target: { value: 'custom' } } as unknown as Event);
      fixture.detectChanges();
      const nameInput = fixture.nativeElement.querySelector(
        '[data-testid="create-project-name"]'
      ) as HTMLInputElement;
      expect(nameInput.value).toBe('custom');

      // A second browse must keep the user's edit instead of clobbering it.
      openMock.mockResolvedValueOnce('/Users/me/projects/second');
      await component.browse();
      fixture.detectChanges();
      const refreshedName = fixture.nativeElement.querySelector(
        '[data-testid="create-project-name"]'
      ) as HTMLInputElement;
      expect(refreshedName.value).toBe('custom');
    });

    it('is a no-op when the user cancels the picker (returns null)', async () => {
      openMock.mockResolvedValue(null);
      await component.browse();
      fixture.detectChanges();
      const dirInput = fixture.nativeElement.querySelector(
        '[data-testid="create-project-dir"]'
      ) as HTMLInputElement;
      expect(dirInput.value).toBe('');
    });

    it('surfaces a picker error inline', async () => {
      openMock.mockRejectedValue(new Error('picker permission denied'));
      await component.browse();
      fixture.detectChanges();
      const err = fixture.nativeElement.querySelector('[data-testid="create-project-error"]');
      expect(err?.textContent).toContain('picker permission denied');
    });
  });

  describe('submit()', () => {
    it('invokes create_project and emits `created` on success', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      const created = vi.fn();
      component.created.subscribe(created);

      openMock.mockResolvedValue('/Users/me/projects/demo');
      await component.browse();
      fixture.detectChanges();

      await component.submit();

      expect(invokeSpy).toHaveBeenCalledWith('create_project', {
        name: 'demo',
        dir: '/Users/me/projects/demo',
      });
      expect(created).toHaveBeenCalledWith({ name: 'demo', dir: '/Users/me/projects/demo' });
    });

    it('does nothing when canSubmit is false (empty name + dir)', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke');
      const created = vi.fn();
      component.created.subscribe(created);
      await component.submit();
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(created).not.toHaveBeenCalled();
    });

    it('shows an inline error and does not emit `created` on backend failure', async () => {
      vi.spyOn(mockTauri, 'invoke').mockRejectedValue(new Error('compose render failed'));
      const created = vi.fn();
      component.created.subscribe(created);

      openMock.mockResolvedValue('/Users/me/projects/demo');
      await component.browse();
      await component.submit();
      fixture.detectChanges();

      const err = fixture.nativeElement.querySelector('[data-testid="create-project-error"]');
      expect(err?.textContent).toContain('compose render failed');
      expect(created).not.toHaveBeenCalled();
    });

    it('trims whitespace around the project name before invoking', async () => {
      const invokeSpy = vi.spyOn(mockTauri, 'invoke').mockResolvedValue(undefined);
      openMock.mockResolvedValue('/Users/me/projects/demo');
      await component.browse();
      component.onNameInput({ target: { value: '  my-name  ' } } as unknown as Event);
      await component.submit();
      expect(invokeSpy).toHaveBeenCalledWith('create_project', {
        name: 'my-name',
        dir: '/Users/me/projects/demo',
      });
    });
  });

  describe('cancel() — dismissibility contract', () => {
    it('emits `closed` when dismissible (default)', () => {
      const closed = vi.fn();
      component.closed.subscribe(closed);
      component.cancel();
      expect(closed).toHaveBeenCalled();
    });

    it('does not emit `closed` when dismissible is false', () => {
      fixture.componentRef.setInput('dismissible', false);
      fixture.detectChanges();
      const closed = vi.fn();
      component.closed.subscribe(closed);
      component.cancel();
      expect(closed).not.toHaveBeenCalled();
    });

    it('does not emit `closed` while a submit is in flight', async () => {
      // Stub invoke to never resolve so `busy` stays true while we test cancel.
      let resolveInvoke!: () => void;
      vi.spyOn(mockTauri, 'invoke').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            resolveInvoke = resolve;
          })
      );
      const closed = vi.fn();
      component.closed.subscribe(closed);

      openMock.mockResolvedValue('/Users/me/projects/demo');
      await component.browse();
      // Fire-and-forget: do not await — busy must stay true for this assertion.
      void component.submit();
      component.cancel();

      expect(closed).not.toHaveBeenCalled();
      // Clean up: let submit finish so the test does not leak a pending promise.
      resolveInvoke();
      await Promise.resolve();
    });
  });
});
