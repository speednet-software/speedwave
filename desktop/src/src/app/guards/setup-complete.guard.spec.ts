import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { RouterModule } from '@angular/router';
import { setupCompleteGuard } from './setup-complete.guard';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('setupCompleteGuard', () => {
  let mockTauri: MockTauriService;
  let router: Router;

  beforeEach(async () => {
    mockTauri = new MockTauriService();

    await TestBed.configureTestingModule({
      imports: [RouterModule.forRoot([])],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    router = TestBed.inject(Router);
  });

  it('should allow access when setup is complete', async () => {
    mockTauri.invokeHandler = async () => true;
    const result = await TestBed.runInInjectionContext(() =>
      setupCompleteGuard({} as never, {} as never)
    );
    expect(result).toBe(true);
  });

  it('should redirect to /setup when setup is not complete', async () => {
    mockTauri.invokeHandler = async () => false;
    const result = await TestBed.runInInjectionContext(() =>
      setupCompleteGuard({} as never, {} as never)
    );
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/setup');
  });

  it('should allow access (fail-open) when invoke throws', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('not running in tauri');
    };
    const result = await TestBed.runInInjectionContext(() =>
      setupCompleteGuard({} as never, {} as never)
    );
    expect(result).toBe(true);
  });
});
