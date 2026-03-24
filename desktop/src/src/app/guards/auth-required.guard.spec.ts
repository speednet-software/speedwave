import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { RouterModule } from '@angular/router';
import { authRequiredGuard } from './auth-required.guard';
import { ProjectStateService } from '../services/project-state.service';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('authRequiredGuard', () => {
  let router: Router;
  let projectState: ProjectStateService;

  beforeEach(async () => {
    const mockTauri = new MockTauriService();

    await TestBed.configureTestingModule({
      imports: [RouterModule.forRoot([])],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    router = TestBed.inject(Router);
    projectState = TestBed.inject(ProjectStateService);
  });

  it('should allow access when status is ready', () => {
    projectState.status = 'ready';
    const result = TestBed.runInInjectionContext(() => authRequiredGuard({} as never, {} as never));
    expect(result).toBe(true);
  });

  it('should redirect to /settings when status is auth_required', () => {
    projectState.status = 'auth_required';
    const result = TestBed.runInInjectionContext(() => authRequiredGuard({} as never, {} as never));
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/settings');
  });

  it('should allow access (fail-open) during transient states', () => {
    projectState.status = 'loading';
    const result = TestBed.runInInjectionContext(() => authRequiredGuard({} as never, {} as never));
    expect(result).toBe(true);
  });
});
