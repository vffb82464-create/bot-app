const installButton = document.getElementById('install-app-btn');
const installStatus = document.getElementById('install-app-status');
let pendingInstallPrompt = null;

function isAppInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function updateInstallVisibility() {
  if (installButton) installButton.hidden = isAppInstalled();
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  pendingInstallPrompt = event;
});

window.addEventListener('appinstalled', () => {
  pendingInstallPrompt = null;
  if (installStatus) installStatus.textContent = 'Panel Bot est installé sur ce téléphone.';
  updateInstallVisibility();
});

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/service-worker.js', { scope: '/' }).catch((error) => {
    console.error('Impossible de préparer l’installation du panel :', error);
    if (installStatus) {
      installStatus.textContent = 'Installation indisponible pour le moment. Réessaie après avoir rechargé la page.';
    }
  });
}

if (installButton) {
  installButton.addEventListener('click', async () => {
    if (isAppInstalled()) {
      updateInstallVisibility();
      return;
    }

    if (!pendingInstallPrompt) {
      const isAppleMobile = /iPhone|iPad|iPod/.test(navigator.userAgent);
      if (installStatus) {
        installStatus.textContent = isAppleMobile
          ? 'Dans Safari, touche Partager puis « Sur l’écran d’accueil ».'
          : 'Dans Chrome, ouvre ⋮ puis choisis « Installer l’application » ou « Ajouter à l’écran d’accueil ».';
      }
      return;
    }

    try {
      const promptEvent = pendingInstallPrompt;
      pendingInstallPrompt = null;
      await promptEvent.prompt();
      const choice = await promptEvent.userChoice;
      if (installStatus) {
        installStatus.textContent = choice.outcome === 'accepted'
          ? 'Panel Bot est en cours d’installation.'
          : 'Installation annulée. Tu peux la relancer depuis ce bouton.';
      }
    } catch (error) {
      console.error('Échec de la demande d’installation :', error);
      if (installStatus) {
        installStatus.textContent = 'Installation impossible. Utilise le menu de ton navigateur pour ajouter le panel à l’écran d’accueil.';
      }
    }
  });
}

updateInstallVisibility();
