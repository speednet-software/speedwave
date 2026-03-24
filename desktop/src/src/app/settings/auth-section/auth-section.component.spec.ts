import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AuthSectionComponent } from './auth-section.component';
import { TauriService } from '../../services/tauri.service';
import { ProjectStateService } from '../../services/project-state.service';
import { MockTauriService } from '../../testing/mock-tauri.service';

function setupMockTauri(mockTauri: MockTauriService): void {
  mockTauri.invokeHandler = async (cmd: string) => {
    switch (cmd) {
      case 'get_auth_status':
        return { api_key_configured: false, oauth_authenticated: false };
      default:
        return undefined;
    }
  };
}

describe('AuthSectionComponent', () => {
  let component: AuthSectionComponent;
  let fixture: ComponentFixture<AuthSectionComponent>;
  let mockTauri: MockTauriService;

  beforeEach(async () => {
    mockTauri = new MockTauriService();
    setupMockTauri(mockTauri);

    await TestBed.configureTestingModule({
      imports: [AuthSectionComponent],
      providers: [{ provide: TauriService, useValue: mockTauri }],
    }).compileComponents();

    fixture = TestBed.createComponent(AuthSectionComponent);
    component = fixture.componentInstance;
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('defaults to api_key auth method', () => {
    expect(component.authMethod).toBe('api_key');
  });

  it('defaults to anthropic llm provider', () => {
    expect(component.llmProvider).toBe('anthropic');
  });

  it('shows anthropic auth section when llmProvider is anthropic', () => {
    component.llmProvider = 'anthropic';
    fixture.detectChanges();
    const heading = fixture.nativeElement.querySelector('h2');
    expect(heading?.textContent).toContain('Authentication');
    const methodSelect = fixture.nativeElement.querySelector(
      '[data-testid="settings-auth-method"]'
    );
    expect(methodSelect).not.toBeNull();
  });

  it('shows ollama message when llmProvider is ollama', () => {
    component.llmProvider = 'ollama';
    fixture.detectChanges();
    const note = fixture.nativeElement.querySelector('[data-testid="auth-note"]');
    expect(note?.textContent).toContain('No authentication needed for Ollama');
  });

  it('shows external message when llmProvider is external', () => {
    component.llmProvider = 'external';
    fixture.detectChanges();
    const note = fixture.nativeElement.querySelector('[data-testid="auth-note"]');
    expect(note?.textContent).toContain('Uses API key env var');
  });

  it('loads auth status when activeProject changes', async () => {
    const spy = vi.spyOn(component, 'loadAuthStatus');
    component.activeProject = 'test-project';
    component.ngOnChanges({
      activeProject: {
        currentValue: 'test-project',
        previousValue: null,
        firstChange: true,
        isFirstChange: () => true,
      },
    });
    expect(spy).toHaveBeenCalled();
  });

  it('sets apiKeyConfigured from auth status response', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        return { api_key_configured: true, oauth_authenticated: false };
      }
      return undefined;
    };
    component.activeProject = 'test-project';
    await component.loadAuthStatus();
    expect(component.apiKeyConfigured).toBe(true);
  });

  it('sets oauthAuthenticated from auth status response', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: true };
      }
      return undefined;
    };
    component.activeProject = 'test-project';
    await component.loadAuthStatus();
    expect(component.oauthAuthenticated).toBe(true);
  });

  it('calls applyAuthStatus when loadAuthStatus detects no auth', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    const applySpy = vi.spyOn(projectState, 'applyAuthStatus');

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, oauth_authenticated: false };
      return undefined;
    };

    component.activeProject = 'test';
    await component.loadAuthStatus();

    expect(applySpy).toHaveBeenCalledWith({
      api_key_configured: false,
      oauth_authenticated: false,
    });
    applySpy.mockRestore();
  });

  it('calls applyAuthStatus when loadAuthStatus finds valid auth', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    const applySpy = vi.spyOn(projectState, 'applyAuthStatus');

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status')
        return { api_key_configured: true, oauth_authenticated: false };
      return undefined;
    };

    component.activeProject = 'test';
    await component.loadAuthStatus();

    expect(applySpy).toHaveBeenCalledWith({ api_key_configured: true, oauth_authenticated: false });
    applySpy.mockRestore();
  });

  it('does not load auth status when activeProject is null', async () => {
    component.activeProject = null;
    await component.loadAuthStatus();
    expect(component.apiKeyConfigured).toBe(false);
  });

  it('saves API key and clears input', async () => {
    let savedKey = '';
    mockTauri.invokeHandler = async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'save_api_key') {
        savedKey = args?.['apiKey'] as string;
        return undefined;
      }
      if (cmd === 'get_auth_status') {
        return { api_key_configured: true, oauth_authenticated: false };
      }
      return undefined;
    };
    component.activeProject = 'test-project';
    component.apiKeyInput = 'sk-ant-test123';
    await component.saveApiKey();
    expect(savedKey).toBe('sk-ant-test123');
    expect(component.apiKeyInput).toBe('');
    expect(component.apiKeySaved).toBe(true);
    expect(component.apiKeyConfigured).toBe(true);
  });

  it('does not save API key without active project', async () => {
    let invoked = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'save_api_key') invoked = true;
      return undefined;
    };
    component.activeProject = null;
    component.apiKeyInput = 'sk-ant-test123';
    await component.saveApiKey();
    expect(invoked).toBe(false);
  });

  it('does not save API key without input', async () => {
    let invoked = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'save_api_key') invoked = true;
      return undefined;
    };
    component.activeProject = 'test-project';
    component.apiKeyInput = '';
    await component.saveApiKey();
    expect(invoked).toBe(false);
  });

  it('emits error on save failure', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'save_api_key') throw new Error('write failed');
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: false };
      }
      return undefined;
    };
    const errorSpy = vi.fn();
    component.errorOccurred.subscribe(errorSpy);
    component.activeProject = 'test-project';
    component.apiKeyInput = 'sk-ant-test123';
    await component.saveApiKey();
    expect(errorSpy).toHaveBeenCalledWith('write failed');
  });

  it('deletes API key and reloads auth status', async () => {
    let deleted = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'delete_api_key') {
        deleted = true;
        return undefined;
      }
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: false };
      }
      return undefined;
    };
    component.activeProject = 'test-project';
    await component.deleteApiKey();
    expect(deleted).toBe(true);
  });

  it('does not delete API key without active project', async () => {
    let invoked = false;
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'delete_api_key') invoked = true;
      return undefined;
    };
    component.activeProject = null;
    await component.deleteApiKey();
    expect(invoked).toBe(false);
  });

  it('emits error on delete failure', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'delete_api_key') throw new Error('delete failed');
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: false };
      }
      return undefined;
    };
    const errorSpy = vi.fn();
    component.errorOccurred.subscribe(errorSpy);
    component.activeProject = 'test-project';
    await component.deleteApiKey();
    expect(errorSpy).toHaveBeenCalledWith('delete failed');
  });

  it('resets authMethod to api_key on OAuth done', async () => {
    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status') {
        return { api_key_configured: false, oauth_authenticated: true };
      }
      return undefined;
    };
    component.activeProject = 'test-project';
    component.authMethod = 'oauth';
    await component.onOAuthDone(true);
    expect(component.authMethod).toBe('api_key');
    expect(component.oauthAuthenticated).toBe(true);
  });

  it('does not render AuthTerminalComponent when activeProject is null even with oauth method', () => {
    component.authMethod = 'oauth';
    component.llmProvider = 'anthropic';
    component.activeProject = null;
    fixture.detectChanges();
    const authEl = fixture.nativeElement.querySelector('app-auth-terminal');
    expect(authEl).toBeNull();
  });

  it('renders AuthTerminalComponent when activeProject is set and authMethod is oauth', () => {
    component.llmProvider = 'anthropic';
    component.activeProject = 'test-project';
    component.authMethod = 'oauth';
    fixture.changeDetectorRef.markForCheck();
    fixture.detectChanges();
    const authEl = fixture.nativeElement.querySelector('app-auth-terminal');
    expect(authEl).not.toBeNull();
  });

  it('displays API Key configured status when key is set', () => {
    component.llmProvider = 'anthropic';
    component.apiKeyConfigured = true;
    fixture.detectChanges();
    const statusEl = fixture.nativeElement.querySelector('[data-testid="auth-status-value"]');
    expect(statusEl?.textContent).toContain('API Key configured');
  });

  it('displays Not authenticated status when no auth configured', () => {
    component.llmProvider = 'anthropic';
    component.apiKeyConfigured = false;
    component.oauthAuthenticated = false;
    fixture.detectChanges();
    const valueEl = fixture.nativeElement.querySelector('[data-testid="auth-status-value"]');
    expect(valueEl?.textContent?.trim()).toContain('Not authenticated');
  });

  it('calls applyAuthStatus after saving API key', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    const applySpy = vi.spyOn(projectState, 'applyAuthStatus');

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'save_api_key') return undefined;
      if (cmd === 'get_auth_status')
        return { api_key_configured: true, oauth_authenticated: false };
      return undefined;
    };

    component.activeProject = 'test';
    component.apiKeyInput = 'sk-ant-test';
    await component.saveApiKey();

    expect(applySpy).toHaveBeenCalledWith({ api_key_configured: true, oauth_authenticated: false });
    applySpy.mockRestore();
  });

  it('calls applyAuthStatus after deleting API key', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    const applySpy = vi.spyOn(projectState, 'applyAuthStatus');

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'delete_api_key') return undefined;
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, oauth_authenticated: false };
      return undefined;
    };

    component.activeProject = 'test';
    await component.deleteApiKey();

    expect(applySpy).toHaveBeenCalledWith({
      api_key_configured: false,
      oauth_authenticated: false,
    });
    applySpy.mockRestore();
  });

  it('calls applyAuthStatus after OAuth done', async () => {
    const projectState = TestBed.inject(ProjectStateService);
    const applySpy = vi.spyOn(projectState, 'applyAuthStatus');

    mockTauri.invokeHandler = async (cmd: string) => {
      if (cmd === 'get_auth_status')
        return { api_key_configured: false, oauth_authenticated: true };
      return undefined;
    };

    component.activeProject = 'test';
    await component.onOAuthDone(true);

    expect(applySpy).toHaveBeenCalledWith({ api_key_configured: false, oauth_authenticated: true });
    applySpy.mockRestore();
  });
});
