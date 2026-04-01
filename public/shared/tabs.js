// Generic tab switching logic

export function initTabs(container) {
  const buttons = container.querySelectorAll('.tab-btn')
  const panels = container.querySelectorAll('.tab-panel')

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return
      const tab = btn.dataset.tab

      buttons.forEach(b => b.classList.toggle('tab-btn--active', b.dataset.tab === tab))
      panels.forEach(p => p.classList.toggle('tab-panel--active', p.dataset.tab === tab))
    })
  })
}

// Activate a specific tab programmatically
export function activateTab(container, tabName) {
  const buttons = container.querySelectorAll('.tab-btn')
  const panels = container.querySelectorAll('.tab-panel')

  buttons.forEach(b => b.classList.toggle('tab-btn--active', b.dataset.tab === tabName))
  panels.forEach(p => p.classList.toggle('tab-panel--active', p.dataset.tab === tabName))
}
