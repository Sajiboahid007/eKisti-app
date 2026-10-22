import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { App } from './app';
import { AuthStateService } from './core/services/auth-state.service';

/**
 * AuthStateService injects Firestore and loads staff on construction,
 * so tests replace it with a lightweight stub (no network / Firebase needed).
 */
function createAuthStub(authenticated: boolean) {
  return { isAuthenticated: signal(authenticated) };
}

async function setup(authenticated: boolean, render = true) {
  await TestBed.configureTestingModule({
    imports: [App],
    providers: [
      provideRouter([]),
      { provide: AuthStateService, useValue: createAuthStub(authenticated) }
    ]
  }).compileComponents();

  const fixture = TestBed.createComponent(App);
  if (render) {
    await fixture.whenStable();
  }
  return fixture;
}

describe('App', () => {
  it('should create the app', async () => {
    const fixture = await setup(false);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should hide navbar and sidebar when not logged in', async () => {
    const fixture = await setup(false);
    const el = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.showLayout()).toBe(false);
    expect(el.querySelector('app-navbar')).toBeNull();
    expect(el.querySelector('router-outlet')).not.toBeNull();
  });

  it('should show the app layout when logged in and not on the login page', async () => {
    // render=false: navbar/sidebar have their own service dependencies; only the layout signal is under test here
    const fixture = await setup(true, false);
    fixture.componentInstance.isLoginPage.set(false);
    expect(fixture.componentInstance.showLayout()).toBe(true);
  });
});
