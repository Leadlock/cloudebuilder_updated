(function () {
  document.querySelectorAll('.reveal').forEach(function (element) {
    Array.from(element.classList).forEach(function (name) {
      if (name === 'reveal' || name === 'visible' || name.startsWith('rv-')) element.classList.remove(name);
    });
  });
  const preference = matchMedia('(prefers-reduced-motion: reduce)');
  const groups = [
    ['.trust-inner > *', 65],
    ['#solutions .section-head > *', 80],
    ['#solutions .entry', 100],
    ['#delivery-use-cases .section-head > *', 80],
    ['#delivery-use-cases .delivery-cell', 65],
    ['#workflow > .shell > .section-head > *', 80],
    ['.journey-phases, .journey-footnote', 60],
    ['.journey-step', 65],
    ['.oversight-copy > *', 80],
    ['.gate-panel .gate', 90],
    ['#teams .section-head > *', 80],
    ['.team-tile', 75],
    ['#scope .sizes-intro > *', 80],
    ['.scope-notice', 100],
    ['#scope .size-callout', 0],
    ['.impact-story > *', 70],
    ['.impact-scorecard-head, .impact-row, .impact-scorecard-foot', 65],
    ['.next-copy > *', 80],
    ['.next-route-heading, .next-input, .next-route-line, .next-result', 75],
    ['footer .footer > *', 65]
  ];
  const elements = new Map();
  let frame = 0;
  groups.forEach(function (group) {
    document.querySelectorAll(group[0]).forEach(function (element, index) {
      elements.set(element, {delay:Math.min(index * group[1], 280),state:'pending',animation:null,generation:0});
      if (!preference.matches) element.classList.add('entrance-pending');
    });
  });
  function reset(element, state) {
    state.generation++;
    if (state.animation) state.animation.cancel();
    state.animation = null;
    state.state = 'pending';
    element.classList.add('entrance-pending');
  }
  function show(element, state, immediate) {
    state.generation++;
    const generation = state.generation;
    if (state.animation) state.animation.cancel();
    if (immediate || preference.matches) {
      state.animation = null;
      state.state = 'visible';
      element.classList.remove('entrance-pending');
      return;
    }
    state.state = 'playing';
    const animation = element.animate([
      {opacity:0,translate:'0 42px'},
      {opacity:1,translate:'0 0'}
    ], {duration:1000,delay:state.delay,easing:'cubic-bezier(.22,1,.36,1)',fill:'both'});
    state.animation = animation;
    function complete() {
      if (state.generation !== generation) return;
      element.classList.remove('entrance-pending');
      state.state = 'visible';
      state.animation = null;
      animation.cancel();
    }
    animation.finished.then(complete, complete);
  }
  function scan() {
    frame = 0;
    if (preference.matches) return;
    const enterAt = innerHeight * .86;
    // Read actual viewport positions, so lower sections cannot start on load.
    const positions = Array.from(elements, function (pair) {
      return {element:pair[0],state:pair[1],rect:pair[0].getBoundingClientRect()};
    });
    positions.forEach(function (item) {
      const rect = item.rect, state = item.state;
      if (!rect.width || !rect.height) return;
      if (rect.bottom < -64 || rect.top > innerHeight + 64) {
        if (state.state !== 'pending') reset(item.element, state);
      } else if (state.state === 'pending' && rect.top < enterAt && rect.bottom > 84) {
        show(item.element, state, false);
      }
    });
  }
  function schedule() { if (!frame) frame = requestAnimationFrame(scan); }
  function revealInteracted(event) {
    elements.forEach(function (state, element) {
      if (element.contains(event.target) && state.state !== 'visible') show(element, state, true);
    });
  }
  document.addEventListener('focusin', revealInteracted, true);
  document.addEventListener('pointerdown', revealInteracted, true);
  addEventListener('scroll', schedule, {passive:true});
  addEventListener('resize', schedule);
  addEventListener('load', schedule);
  addEventListener('pageshow', schedule);
  addEventListener('hashchange', schedule);
  preference.addEventListener('change', function () {
    elements.forEach(function (state, element) {
      if (preference.matches) show(element, state, true);
      else reset(element, state);
    });
    schedule();
  });
  schedule();
})();
