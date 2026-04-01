// Generic collapsible / toggle logic

export function createToggle(labelHtml, contentHtml, { defaultOpen = false, contentClass = '' } = {}) {
  const wrapper = document.createElement('div')
  wrapper.innerHTML = `
    <div class="toggle-header">
      <span class="toggle-indicator">${defaultOpen ? '[-]' : '[+]'}</span> ${labelHtml}
    </div>
    <div class="toggle-body ${defaultOpen ? 'toggle-body--open' : ''} ${contentClass}">
      ${contentHtml}
    </div>
  `
  const header = wrapper.querySelector('.toggle-header')
  const body = wrapper.querySelector('.toggle-body')
  const indicator = wrapper.querySelector('.toggle-indicator')

  header.addEventListener('click', (e) => {
    e.stopPropagation()
    const isOpen = body.classList.toggle('toggle-body--open')
    indicator.textContent = isOpen ? '[-]' : '[+]'
  })

  return wrapper
}

// Wire up all static [data-toggle] elements in a container
export function initCollapsibles(container) {
  container.querySelectorAll('[data-toggle-target]').forEach(header => {
    const targetId = header.dataset.toggleTarget
    const body = container.querySelector(`#${targetId}`)
    if (!body) return

    const indicator = header.querySelector('.toggle-indicator')
    header.style.cursor = 'pointer'

    header.addEventListener('click', (e) => {
      e.stopPropagation()
      const isOpen = body.classList.toggle('toggle-body--open')
      if (indicator) indicator.textContent = isOpen ? '[-]' : '[+]'
    })
  })
}
