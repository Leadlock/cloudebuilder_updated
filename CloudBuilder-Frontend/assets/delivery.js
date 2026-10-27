document.addEventListener('DOMContentLoaded', function () {
  const section = document.querySelector('#delivery-use-cases');
  const dialog = section.querySelector('.delivery-detail');
  const cells = Array.from(section.querySelectorAll('.delivery-cell'));
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const details = [
    ['Move from repository to a reviewable AWS or Azure production environment.', 'Map your application, review the infrastructure plan, and take an approved deployment through verification. Your engineers stay in control at every gate.', ['Discover application dependencies', 'Review architecture and versioned IaC', 'Approve deployment and verify the result']],
    ['Build a cloud foundation your team can grow with.', 'Define identity, networking, compute, data and shared services as code. Establish clear boundaries before adding more workloads.', ['Define account and network boundaries', 'Prepare reusable infrastructure modules', 'Review access and operational controls']],
    ['Create consistent environments with traceable differences.', 'Keep development, UAT and production aligned through a shared infrastructure pattern, with explicit configuration and approval requirements for each environment.', ['Define shared environment patterns', 'Review configuration differences', 'Promote approved changes through environments']],
    ['Surface architecture risks before they reach production.', 'Review service choices against security, reliability, operations and cost needs. Turn the findings into a clear set of decisions your team can evaluate.', ['Inspect the proposed design', 'Document risks and trade-offs', 'Agree the next architecture decisions']],
    ['Turn workload discovery into an actionable migration plan.', 'Understand existing services, data flows and dependencies. Sequence the move with explicit validation and recovery considerations.', ['Map workload and data dependencies', 'Choose the migration sequence', 'Plan validation and recovery checkpoints']],
    ['Make customer deployments repeatable.', 'Package a reviewed infrastructure pattern with configuration, approval gates and handover documentation, ready to adapt to each customer environment.', ['Define the reusable deployment pattern', 'Document customer configuration inputs', 'Validate and hand over the blueprint']],
    ['01 / Connect — define the starting point.', 'Bring the application repository, an architecture proposal or an existing cloud environment. Agree the workload, owners and constraints before engineering begins.', ['Choose the workload and target cloud', 'Identify inputs and required access', 'Agree ownership and scope boundaries']],
    ['02 / Discover — understand what the workload needs.', 'Map components, runtime requirements, data flows and external dependencies so the proposed infrastructure reflects the application.', ['Map services and dependencies', 'Capture runtime and data requirements', 'Record assumptions for review']],
    ['03 / Architect — turn requirements into a design.', 'Shape the AWS or Azure architecture around availability, networking, identity, operations and cost considerations. Make trade-offs explicit for your team.', ['Select services and define boundaries', 'Document availability and access choices', 'Prepare the architecture for review']],
    ['04 / Validate — review risk before implementation.', 'Check the proposed architecture against workload requirements and production-readiness needs. Your team reviews findings and approves the next steps.', ['Review security and reliability risks', 'Resolve assumptions and trade-offs', 'Confirm the approved architecture']],
    ['05 / Generate — produce versioned infrastructure code.', 'Translate the reviewed design into infrastructure assets your engineers can inspect, track and maintain in their delivery workflow.', ['Generate the infrastructure blueprint', 'Review configuration and planned changes', 'Version the approved infrastructure assets']],
    ['06 / Deploy — execute an approved plan.', 'Your engineers choose when and where the reviewed infrastructure plan runs. Deployment follows the agreed environment boundaries and approval gates.', ['Confirm the target environment', 'Obtain approval before execution', 'Apply the reviewed deployment plan']],
    ['07 / Verify — confirm the deployed result.', 'Check the environment against the approved plan and workload needs. Record validation results and identify any follow-up work before handover.', ['Check infrastructure and application health', 'Validate the required operational controls', 'Record results and handover actions']],
    ['08 / Govern — keep changes reviewable.', 'Maintain visibility into configuration and subsequent changes. Reuse the approved patterns and keep ownership, documentation and change decisions clear.', ['Track configuration and proposed changes', 'Review drift and operational findings', 'Maintain documentation and ownership']]
  ];
  let origin, closing = false, previousOverflow = '';
  addEventListener('cloudbuilder:themechange', function () {
    if (!dialog.open || !origin) return;
    const colors = getComputedStyle(origin);
    dialog.style.setProperty('--detail-bg', colors.getPropertyValue('--cell-tile'));
    dialog.style.setProperty('--detail-ink', colors.getPropertyValue('--cell-icon'));
  });
  function transformFromCell() {
    const from = origin.getBoundingClientRect();
    const to = dialog.getBoundingClientRect();
    return 'translate(' + (from.left + from.width / 2 - to.left - to.width / 2) + 'px,' + (from.top + from.height / 2 - to.top - to.height / 2) + 'px) scale(' + Math.max(.15, from.width / to.width) + ',' + Math.max(.12, from.height / to.height) + ')';
  }
  cells.forEach(function (cell, index) {
    cell.addEventListener('click', function () {
      origin = cell; closing = false;
      const theme = getComputedStyle(cell);
      dialog.style.setProperty('--detail-bg', theme.getPropertyValue('--cell-tile'));
      dialog.style.setProperty('--detail-ink', theme.getPropertyValue('--cell-icon'));
      dialog.querySelector('.detail-banner .delivery-icon').replaceChildren(cell.querySelector('svg').cloneNode(true));
      dialog.querySelector('#delivery-detail-title').textContent = cell.querySelector('strong').textContent;
      dialog.querySelector('.detail-summary').textContent = details[index][0];
      dialog.querySelector('.detail-description').textContent = details[index][1];
      const isWorkflow = cell.closest('#workflow') !== null;
      const cta = dialog.querySelector('.detail-cta');
      cta.textContent = isWorkflow ? 'Catalogue ↗' : 'See workflow ↗';
      cta.href = isWorkflow ? './deployment-catalogue/' : '#workflow';
      dialog.querySelector('.detail-process-label').textContent = isWorkflow ? 'DELIVERY CHECKPOINTS' : 'YOUR DELIVERY PATH';
      const steps = dialog.querySelector('.detail-process ol');
      steps.replaceChildren(...details[index][2].map(function (text) { const li = document.createElement('li'); li.textContent = text; return li; }));
      cell.setAttribute('aria-expanded', 'true');
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      dialog.showModal(); dialog.scrollTop = 0;
      if (!motion.matches) {
        dialog.animate([{transform:transformFromCell(),opacity:.2,borderRadius:'14px'}, {transform:'none',opacity:1,borderRadius:'25px'}], {duration:600,easing:'cubic-bezier(.22,1,.36,1)'});
        dialog.querySelector('.detail-body').animate([{opacity:0,transform:'translateY(16px)'},{opacity:1,transform:'none'}],{duration:400,delay:180,fill:'backwards',easing:'ease-out'});
        dialog.querySelector('.detail-banner .delivery-icon').animate([{transform:'scale(.7)',opacity:.3},{transform:'scale(1)',opacity:1}],{duration:500,delay:100,fill:'backwards',easing:'cubic-bezier(.22,1,.36,1)'});
      }
    });
  });
  async function closeDetail() {
    if (closing || !dialog.open) return;
    closing = true;
    if (!motion.matches) {
      dialog.getAnimations({subtree:true}).forEach(animation => animation.cancel());
      await dialog.animate([{transform:'none',opacity:1},{transform:transformFromCell(),opacity:0}],{duration:380,easing:'cubic-bezier(.4,0,.2,1)'}).finished;
    }
    dialog.close();
  }
  dialog.querySelector('.delivery-close').addEventListener('click', closeDetail);
  dialog.addEventListener('cancel', function (event) { event.preventDefault(); closeDetail(); });
  dialog.addEventListener('click', function (event) {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) closeDetail();
  });
  dialog.addEventListener('close', function () {
    document.body.style.overflow = previousOverflow;
    if (origin) { origin.setAttribute('aria-expanded','false'); origin.focus({preventScroll:true}); }
    closing = false;
  });
  dialog.querySelector('.detail-cta').addEventListener('click', function () { dialog.close(); });
});
