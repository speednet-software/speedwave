import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree } from '@angular/router';
import { RouterModule } from '@angular/router';
import { betaEnabledGuard } from './beta-enabled.guard';
import { TauriService } from '../services/tauri.service';
import { MockTauriService } from '../testing/mock-tauri.service';

describe('betaEnabledGuard', () => {
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

  it('allows access when beta is enabled', async () => {
    mockTauri.invokeHandler = async () => true;
    const result = await TestBed.runInInjectionContext(() =>
      betaEnabledGuard({} as never, {} as never)
    );
    expect(result).toBe(true);
  });

  it('redirects to /chat when beta is disabled', async () => {
    mockTauri.invokeHandler = async () => false;
    const result = await TestBed.runInInjectionContext(() =>
      betaEnabledGuard({} as never, {} as never)
    );
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/chat');
  });

  it('redirects to /chat (fail-closed) when invoke throws', async () => {
    mockTauri.invokeHandler = async () => {
      throw new Error('not running in tauri');
    };
    const result = await TestBed.runInInjectionContext(() =>
      betaEnabledGuard({} as never, {} as never)
    );
    expect(result).toBeInstanceOf(UrlTree);
    expect(router.serializeUrl(result as UrlTree)).toBe('/chat');
  });
});
