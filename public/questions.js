(() => {
  'use strict';
  // An agent's questions with options (Claude's AskUserQuestion, Codex's request_user_input), shown where approvals
  // wait. One question shows at a time, with its choices, the one the agent suggests marked Recommended, and a box for
  // your own answer where the agent allows one. With several questions, their headers are tabs: choosing an option
  // moves on to the next unanswered question, Next does the same, and Submit sends every answer once each has one.
  // Skip lets the agent decide. In the card, number keys choose an option and Enter goes on.
  const api = () => window.relayUI;
  const names = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
  const RECOMMENDED = /\s*\(recommended\)\s*$/i;
  const node = (tag, text, cls) => { const value = document.createElement(tag); if (text !== undefined) value.textContent = text; if (cls) value.className = cls; return value; };
  const button = (text, cls) => { const value = node('button', text, cls); value.type = 'button'; return value; };

  // One question: its options as radio buttons, or checkboxes when several may be chosen, then your own answer.
  // `chosen` runs when a single choice is made, so the card can move on.
  function group(question, index, cardId, { changed, chosen, tabs }) {
    const field = node('fieldset', undefined, 'question'), legend = node('legend', undefined, 'question-legend');
    if (question.header && !tabs) legend.append(node('span', question.header, 'question-header'));
    legend.append(node('span', question.question, 'question-text'));
    field.append(legend);
    // Finishing something in a browser, such as a connector's sign-in: the address shows who it goes to.
    if (question.link) {
      const open = button(`Open ${new URL(question.link).host}`, 'question-link');
      open.title = question.link;
      open.addEventListener('click', async () => { try { if (window.relayDesktop) await window.relayDesktop.openExternal(question.link); else window.open(question.link, '_blank', 'noopener,noreferrer'); } catch (error) { api().showNotice(error.message || 'The link could not be opened.'); } });
      field.append(open);
    }
    if (question.multiple) field.append(node('p', 'Choose all that apply.', 'question-hint'));
    const type = question.multiple ? 'checkbox' : 'radio', name = `question-${cardId}-${index}`, choices = [];
    question.options.forEach((option, position) => {
      const row = node('label', undefined, 'question-option'), input = node('input'), body = node('span', undefined, 'question-option-body'), title = node('span', undefined, 'question-option-label');
      input.type = type; input.name = name; input.value = option.label;
      title.append(node('span', option.label.replace(RECOMMENDED, '') || option.label));
      if (option.recommended) title.append(node('span', 'Recommended', 'question-recommended'));
      body.append(title);
      if (option.description) body.append(node('span', option.description, 'question-option-description'));
      row.append(input, body);
      if (position < 9) { const key = node('kbd', String(position + 1), 'question-key'); key.setAttribute('aria-hidden', 'true'); row.append(key); }
      field.append(row); choices.push(input);
    });
    // Your own answer: beside the options it is one more choice, picked as you type; alone, it is the answer.
    let own = null, ownChoice = null;
    if (question.other) {
      own = node('input', undefined, 'question-own');
      own.type = question.secret ? 'password' : 'text'; own.maxLength = 2000; own.autocomplete = 'off';
      own.placeholder = question.options.length ? 'Something else…' : 'Your answer';
      own.setAttribute('aria-label', question.options.length ? 'Your own answer' : question.question);
      if (question.options.length) {
        const row = node('label', undefined, 'question-option question-option-own');
        ownChoice = node('input'); ownChoice.type = type; ownChoice.name = name; ownChoice.value = '';
        ownChoice.setAttribute('aria-label', 'Answer in your own words');
        row.append(ownChoice, own); field.append(row);
        own.addEventListener('input', () => { if (own.value.trim()) choose(ownChoice, true); changed(); });
      } else { field.append(own); own.addEventListener('input', changed); }
    }
    // A single choice keeps one input checked, whichever way it was chosen.
    function choose(input, on) {
      if (type === 'radio') for (const other of [...choices, ownChoice].filter(Boolean)) other.checked = other === input && on;
      else input.checked = on;
    }
    for (const input of [...choices, ownChoice].filter(Boolean)) input.addEventListener('change', () => {
      choose(input, input.checked);
      if (input === ownChoice && input.checked) own.focus();
      changed();
      if (type === 'radio' && input !== ownChoice && input.checked) chosen();
    });
    const ownValue = () => own && (!ownChoice || ownChoice.checked) ? own.value.trim() : '';
    return {
      element: field, question,
      values: () => [...choices.filter(input => input.checked).map(input => input.value), ...(ownValue() ? [ownValue()] : [])],
      // A number key: a single choice is made and the card moves on; a checkbox turns on or off.
      pick(position) { const input = choices[position]; if (!input) return; choose(input, type === 'radio' || !input.checked); changed(); if (type === 'radio') chosen(); else input.focus(); },
      focus() { ([...choices, ownChoice].find(input => input?.checked) || choices[0] || own)?.focus(); },
    };
  }

  function card(item, conversationId) {
    const projectId = api().getState().projectId;
    const article = node('article', undefined, 'approval-card question-card'), head = node('header'), mark = node('span', undefined, 'approval-icon question-icon');
    mark.setAttribute('aria-hidden', 'true');
    article.dataset.approvalId = item.id; article.tabIndex = -1;
    const agent = names[item.provider] || 'The agent', count = item.questions.length;
    head.append(mark, node('h3', count === 1 ? `${agent} has a question` : `${agent} has ${count} questions`));
    article.append(head);
    if (item.blocking === false) article.append(node('p', `${agent} can keep working while you answer. After the run finishes, your answer goes into your draft for you to send.`, 'question-hint'));
    const skip = button('Skip', 'question-skip'), primary = button('Submit', 'primary question-submit');
    skip.title = `${agent} continues with its own judgement`;
    let sending = false, current = 0;
    const tabs = count > 1 ? node('div', undefined, 'question-tabs') : null;
    const groups = item.questions.map((question, index) => group(question, index, item.id, { changed: () => changed(), chosen: () => advance(), tabs: Boolean(tabs) }));
    const answered = () => groups.every(entry => entry.values().length);
    const unanswered = () => groups.findIndex((entry, index) => index !== current && !entry.values().length);
    if (tabs) {
      tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Questions');
      groups.forEach((entry, index) => {
        const tab = button(entry.question.header || `Question ${index + 1}`, 'question-tab');
        tab.setAttribute('role', 'tab'); tab.title = entry.question.question;
        tab.addEventListener('click', () => show(index, true));
        tabs.append(tab);
      });
      article.append(tabs);
    }
    for (const entry of groups) article.append(entry.element);
    // Showing a question hides the others. Focus follows only if it was already in the card, so a question that
    // arrives never takes it from what you are typing.
    function show(index, focus = false) {
      const inside = focus || article.contains?.(document.activeElement);
      current = index;
      groups.forEach((entry, position) => { entry.element.hidden = position !== index; });
      changed();
      if (inside) groups[index].focus();
    }
    // After a single choice, the next question still without an answer, if any.
    function advance() { const next = unanswered(); if (next >= 0) show(next, true); }
    function changed() {
      const done = answered();
      primary.textContent = done || !tabs ? item.blocking === false ? 'Send answer' : 'Submit' : 'Next';
      primary.disabled = sending || (done ? false : !tabs || !groups[current].values().length);
      if (tabs) [...tabs.children].forEach((tab, index) => {
        tab.setAttribute('aria-selected', String(index === current));
        tab.classList.toggle('answered', groups[index].values().length > 0);
      });
    }
    async function send(answers) {
      if (sending) return;
      sending = true; skip.disabled = true; changed();
      const body = { runId: item.runId, questionId: item.id, ...(answers ? { answers } : { skip: true }) };
      try {
        const result = await api().post(`/api/conversations/${conversationId}/answer`, body);
        if (result.draft) api().prepareQuestionAnswer(conversationId, result.draft, projectId);
      }
      catch (error) { api().showNotice(error.message || 'Your answer could not be sent. Please try again.'); }
      finally { sending = false; skip.disabled = false; changed(); await api().refresh(); }
    }
    primary.addEventListener('click', () => { if (answered()) send(groups.map(entry => entry.values())); else if (groups[current].values().length) advance(); });
    skip.addEventListener('click', () => send(null));
    article.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target, typing = target?.tagName === 'INPUT' && ['text', 'password'].includes(target.type);
      if (event.key === 'Enter' && !event.shiftKey && target?.tagName !== 'BUTTON') { event.preventDefault(); if (!primary.disabled) primary.click(); return; }
      if (typing || !/^[1-9]$/.test(event.key)) return;
      event.preventDefault(); groups[current].pick(Number(event.key) - 1);
    });
    const footer = node('div', undefined, 'approval-footer question-footer'), actions = node('div', undefined, 'workbench-actions');
    actions.append(skip, primary);
    footer.append(node('span', 'Press a number to choose · Enter to go on', 'question-shortcuts'), actions);
    article.append(footer);
    show(0);
    return article;
  }

  window.relayQuestions = { card };
})();
