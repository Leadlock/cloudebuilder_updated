(function () {
  'use strict';

  function initAuthModal() {
    const backdrop = document.getElementById('cb-auth-modal');
    if (!backdrop) return;

    const modalTitle = document.getElementById('cb-modal-title');
    const modalSubtitle = document.getElementById('cb-modal-subtitle');
    const tabSignin = document.getElementById('cb-tab-signin');
    const tabSignup = document.getElementById('cb-tab-signup');
    const tabsContainer = document.getElementById('cb-auth-tabs');
    const authForm = document.getElementById('cb-auth-form');
    const alertBox = document.getElementById('cb-auth-alert');
    const alertMessage = document.getElementById('cb-alert-message');
    const submitBtn = document.getElementById('cb-auth-submit');
    const submitText = document.getElementById('cb-submit-text');
    const submitSpinner = document.getElementById('cb-submit-spinner');
    const closeBtn = document.getElementById('cb-modal-close');

    // Fields
    const fieldName = document.getElementById('cb-field-name');
    const fieldOrg = document.getElementById('cb-field-org');
    const fieldEmail = document.getElementById('cb-field-email');
    const fieldPassword = document.getElementById('cb-field-password');
    const fieldMfa = document.getElementById('cb-field-mfa');
    const extraLinks = document.getElementById('cb-auth-extra');
    const forgotLink = document.getElementById('cb-forgot-link');
    const backToSigninLink = document.getElementById('cb-back-to-signin');

    const inputName = document.getElementById('cb-input-name');
    const inputOrg = document.getElementById('cb-input-org');
    const inputEmail = document.getElementById('cb-input-email');
    const inputPassword = document.getElementById('cb-input-password');
    const inputMfa = document.getElementById('cb-input-mfa');

    let currentMode = 'signin'; // 'signin' | 'signup' | 'forgot' | 'mfa'
    let mfaSession = '';
    let mfaMethod = 'app';

    function showAlert(msg, isError) {
      if (!alertBox || !alertMessage) return;
      alertMessage.textContent = msg;
      alertBox.className = 'cb-auth-alert ' + (isError ? 'is-error' : 'is-info');
      alertBox.style.display = 'flex';
    }

    function clearAlert() {
      if (!alertBox) return;
      alertBox.style.display = 'none';
      if (alertMessage) alertMessage.textContent = '';
    }

    function setMode(mode) {
      currentMode = mode;
      clearAlert();

      if (mode === 'signin') {
        if (modalTitle) modalTitle.textContent = 'Welcome Back';
        if (modalSubtitle) modalSubtitle.textContent = 'Sign in to access your cloud workspace';
        if (tabsContainer) tabsContainer.style.display = 'grid';
        if (tabSignin) tabSignin.classList.add('is-active');
        if (tabSignup) tabSignup.classList.remove('is-active');

        if (fieldName) fieldName.style.display = 'none';
        if (fieldOrg) fieldOrg.style.display = 'none';
        if (fieldEmail) fieldEmail.style.display = 'flex';
        if (fieldPassword) fieldPassword.style.display = 'flex';
        if (fieldMfa) fieldMfa.style.display = 'none';
        if (extraLinks) extraLinks.style.display = 'flex';
        if (backToSigninLink) backToSigninLink.style.display = 'none';

        if (submitText) submitText.textContent = 'Sign In →';
        if (inputEmail) setTimeout(function () { inputEmail.focus(); }, 60);
      } else if (mode === 'signup') {
        if (modalTitle) modalTitle.textContent = 'Create Workspace';
        if (modalSubtitle) modalSubtitle.textContent = 'Start designing and deploying infrastructure';
        if (tabsContainer) tabsContainer.style.display = 'grid';
        if (tabSignin) tabSignin.classList.remove('is-active');
        if (tabSignup) tabSignup.classList.add('is-active');

        if (fieldName) fieldName.style.display = 'flex';
        if (fieldOrg) fieldOrg.style.display = 'flex';
        if (fieldEmail) fieldEmail.style.display = 'flex';
        if (fieldPassword) fieldPassword.style.display = 'flex';
        if (fieldMfa) fieldMfa.style.display = 'none';
        if (extraLinks) extraLinks.style.display = 'none';
        if (backToSigninLink) backToSigninLink.style.display = 'none';

        if (submitText) submitText.textContent = 'Create Workspace Account →';
        if (inputName) setTimeout(function () { inputName.focus(); }, 60);
      } else if (mode === 'forgot') {
        if (modalTitle) modalTitle.textContent = 'Recover Access';
        if (modalSubtitle) modalSubtitle.textContent = 'We will send a reset code to your work email';
        if (tabsContainer) tabsContainer.style.display = 'none';

        if (fieldName) fieldName.style.display = 'none';
        if (fieldOrg) fieldOrg.style.display = 'none';
        if (fieldEmail) fieldEmail.style.display = 'flex';
        if (fieldPassword) fieldPassword.style.display = 'none';
        if (fieldMfa) fieldMfa.style.display = 'none';
        if (extraLinks) extraLinks.style.display = 'none';
        if (backToSigninLink) backToSigninLink.style.display = 'block';

        if (submitText) submitText.textContent = 'Send Reset Code →';
        if (inputEmail) setTimeout(function () { inputEmail.focus(); }, 60);
      } else if (mode === 'mfa') {
        if (modalTitle) modalTitle.textContent = 'Two-Factor Verification';
        if (modalSubtitle) modalSubtitle.textContent = 'Enter the 6-digit code from your authenticator app';
        if (tabsContainer) tabsContainer.style.display = 'none';

        if (fieldName) fieldName.style.display = 'none';
        if (fieldOrg) fieldOrg.style.display = 'none';
        if (fieldEmail) fieldEmail.style.display = 'none';
        if (fieldPassword) fieldPassword.style.display = 'none';
        if (fieldMfa) fieldMfa.style.display = 'flex';
        if (extraLinks) extraLinks.style.display = 'none';
        if (backToSigninLink) backToSigninLink.style.display = 'block';

        if (submitText) submitText.textContent = 'Verify & Enter Workspace →';
        if (inputMfa) setTimeout(function () { inputMfa.focus(); }, 60);
      }
    }

    function openModal(mode) {
      backdrop.classList.add('is-open');
      document.body.style.overflow = 'hidden';
      setMode(mode || 'signin');
    }

    function closeModal() {
      backdrop.classList.remove('is-open');
      document.body.style.overflow = '';
      clearAlert();
      if (inputPassword) inputPassword.value = '';
      if (inputMfa) inputMfa.value = '';
    }

    // Attach open handlers
    document.querySelectorAll('[data-auth-modal]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const mode = btn.dataset.authModal || (btn.textContent.toLowerCase().includes('sign up') ? 'signup' : 'signin');
        openModal(mode);
      });
    });

    // Also wire up any header buttons that say "Log in" or "Sign up"
    document.querySelectorAll('.cc-header-button, .cc-mobile-auth').forEach(function (btn) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text.includes('log in') || text.includes('sign in')) {
        btn.setAttribute('data-auth-modal', 'signin');
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openModal('signin');
        });
      } else if (text.includes('sign up') || text.includes('register')) {
        btn.setAttribute('data-auth-modal', 'signup');
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          openModal('signup');
        });
      }
    });

    // Close on backdrop click
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeModal();
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', function (e) {
        e.preventDefault();
        closeModal();
      });
    }

    // Escape key
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && backdrop.classList.contains('is-open')) {
        closeModal();
      }
    });

    // Tab buttons
    if (tabSignin) {
      tabSignin.addEventListener('click', function () { setMode('signin'); });
    }
    if (tabSignup) {
      tabSignup.addEventListener('click', function () { setMode('signup'); });
    }

    if (forgotLink) {
      forgotLink.addEventListener('click', function (e) {
        e.preventDefault();
        setMode('forgot');
      });
    }

    if (backToSigninLink) {
      backToSigninLink.addEventListener('click', function (e) {
        e.preventDefault();
        setMode('signin');
      });
    }

    // Password toggles
    document.querySelectorAll('.cb-pw-toggle').forEach(function (toggle) {
      toggle.addEventListener('click', function () {
        const input = toggle.parentElement.querySelector('input');
        if (!input) return;
        const isPw = input.type === 'password';
        input.type = isPw ? 'text' : 'password';
        toggle.setAttribute('aria-label', isPw ? 'Hide password' : 'Show password');
      });
    });

    // Form submission
    if (authForm) {
      authForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        clearAlert();

        const email = (inputEmail ? inputEmail.value : '').trim();
        const password = inputPassword ? inputPassword.value : '';
        const name = (inputName ? inputName.value : '').trim();
        const orgName = (inputOrg ? inputOrg.value : '').trim();
        const mfaCode = (inputMfa ? inputMfa.value : '').trim();

        if (currentMode === 'signin' && (!email || !password)) {
          showAlert('Please enter your email and password.', true);
          return;
        }

        if (currentMode === 'signup') {
          if (!name) { showAlert('Please enter your full name.', true); return; }
          if (!email) { showAlert('Please enter your work email.', true); return; }
          if (!password || password.length < 8) { showAlert('Password must be at least 8 characters long.', true); return; }
        }

        if (currentMode === 'mfa' && !mfaCode) {
          showAlert('Please enter the 6-digit MFA code.', true);
          return;
        }

        // Set loading state
        if (submitBtn) submitBtn.disabled = true;
        if (submitSpinner) submitSpinner.style.display = 'inline-block';

        try {
          if (currentMode === 'forgot') {
            const res = await fetch('/api/auth/forgot-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ email: email })
            });
            const data = await res.json();
            if (!res.ok || data.ok === false) {
              throw new Error(data.error?.message || data.error || data.message || 'Failed to send reset code');
            }
            showAlert(data.data?.message || data.message || 'Verification code sent to your email! Check your inbox.', false);
            return;
          }

          if (currentMode === 'mfa') {
            const res = await fetch('/api/auth/mfa/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                email: email,
                session: mfaSession,
                method: mfaMethod,
                code: mfaCode
              })
            });
            const data = await res.json();
            if (!res.ok || !data.success) {
              throw new Error(data.error?.message || data.error || data.message || 'Verification code incorrect');
            }
            // Success!
            showAlert('Verification successful! Entering workspace...', false);
            setTimeout(function () { window.location.href = '/app'; }, 400);
            return;
          }

          const endpoint = currentMode === 'signin' ? '/api/auth/login' : '/api/auth/signup';
          const payload = currentMode === 'signin'
            ? { email: email, password: password }
            : { email: email, password: password, name: name, orgName: orgName || 'Default Workspace' };

          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
          });

          const data = await res.json();

          if (data.requiresMfa) {
            mfaSession = data.session;
            mfaMethod = data.method || 'app';
            setMode('mfa');
            showAlert(data.message || 'Please enter your authenticator app code.', false);
            return;
          }

          if (data.requiresConfirmation) {
            showAlert('Verification code sent to your email. Please check your inbox.', false);
            return;
          }

          if (!res.ok || !data.success) {
            throw new Error(data.error?.message || data.error || data.message || 'Authentication failed. Please check credentials.');
          }

          // Successful authentication!
          showAlert('Welcome! Launching CloudBuilder workspace...', false);
          setTimeout(function () {
            window.location.href = '/app';
          }, 350);

        } catch (err) {
          showAlert(err.message || 'An error occurred during authentication.', true);
        } finally {
          if (submitBtn) submitBtn.disabled = false;
          if (submitSpinner) submitSpinner.style.display = 'none';
        }
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuthModal);
  } else {
    initAuthModal();
  }
})();
