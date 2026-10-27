document.addEventListener('DOMContentLoaded', function () {
  const grid = document.querySelector('.team-tiles');
  if (!grid) return;
  const tiles = Array.from(grid.querySelectorAll('.team-tile'));
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  function changeSelection(selected) {
    const before = tiles.map(tile => tile.getBoundingClientRect());
    tiles.forEach(tile => tile.getAnimations({subtree:true}).forEach(animation => animation.cancel()));
    grid.classList.toggle('has-selection', !!selected);
    tiles.forEach(function (tile) {
      const active = tile === selected;
      tile.classList.toggle('is-active', active);
      tile.setAttribute('aria-expanded', String(active));
      tile.querySelector('.team-tile-description').hidden = !active;
      tile.querySelector('.team-tile-toggle').textContent = active ? '×' : '•••';
    });
    if (reduced.matches) return;
    tiles.forEach(function (tile, index) {
      const after = tile.getBoundingClientRect();
      const old = before[index];
      tile.animate([{transform:'translate(' + (old.left-after.left) + 'px,' + (old.top-after.top) + 'px) scale(' + old.width/after.width + ',' + old.height/after.height + ')'}, {transform:'none'}], {duration:600,easing:'cubic-bezier(.22,1,.36,1)'});
    });
    if (selected) selected.querySelector('.team-tile-description').animate([{opacity:0,transform:'translateY(10px)'},{opacity:1,transform:'none'}],{duration:350,delay:200,fill:'backwards',easing:'ease-out'});
  }
  tiles.forEach(tile => tile.addEventListener('click', () => changeSelection(tile.classList.contains('is-active') ? null : tile)));
  grid.addEventListener('keydown', event => { if (event.key === 'Escape') changeSelection(null); });
});
