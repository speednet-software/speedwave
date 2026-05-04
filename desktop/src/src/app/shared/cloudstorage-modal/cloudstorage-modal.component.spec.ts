import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CloudStorageModalComponent } from './cloudstorage-modal.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

describe('CloudStorageModalComponent', () => {
  let fixture: ComponentFixture<CloudStorageModalComponent>;
  let mockTauri: MockTauriService;
  const invokeSpy = vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>();
  const retrySpy = vi.fn<() => Promise<void>>();

  beforeEach(async () => {
    invokeSpy.mockReset();
    invokeSpy.mockResolvedValue(undefined);
    retrySpy.mockReset();
    retrySpy.mockResolvedValue(undefined);

    mockTauri = new MockTauriService();
    mockTauri.invokeHandler = invokeSpy;

    const projectStateStub = { retry: retrySpy };

    await TestBed.configureTestingModule({
      imports: [CloudStorageModalComponent],
      providers: [
        { provide: TauriService, useValue: mockTauri },
        { provide: ProjectStateService, useValue: projectStateStub },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(CloudStorageModalComponent);
  });

  it('should not render when visible is false', () => {
    fixture.componentRef.setInput('visible', false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="cloudstorage-modal"]')).toBeNull();
  });

  it('should render modal when visible is true', () => {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="cloudstorage-modal"]')).toBeTruthy();
  });

  it('should show provider name in heading when provider is set', () => {
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('provider', 'OneDrive');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('OneDrive');
  });

  it('should not show provider name when provider is undefined', () => {
    fixture.componentRef.setInput('visible', true);
    fixture.componentRef.setInput('provider', undefined);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const heading = el.querySelector('h2');
    expect(heading?.textContent?.trim()).toBe('Speedwave needs access to');
  });

  it('should render manual instructions list', () => {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const items = el.querySelectorAll('ol li');
    expect(items.length).toBeGreaterThanOrEqual(4);
  });

  it('should render Open System Settings button', () => {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="cloudstorage-open-settings-btn"]')).toBeTruthy();
  });

  it('should render Retry button', () => {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[data-testid="cloudstorage-retry-btn"]')).toBeTruthy();
  });

  it('should call open_files_folders_pane when Open System Settings clicked', async () => {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const btn = el.querySelector<HTMLButtonElement>(
      '[data-testid="cloudstorage-open-settings-btn"]'
    )!;
    btn.click();
    await fixture.whenStable();
    expect(invokeSpy).toHaveBeenCalledWith('open_files_folders_pane', undefined);
  });

  it('should call projectState.retry when Retry clicked', async () => {
    fixture.componentRef.setInput('visible', true);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="cloudstorage-retry-btn"]')!;
    btn.click();
    await fixture.whenStable();
    expect(retrySpy).toHaveBeenCalled();
  });
});
