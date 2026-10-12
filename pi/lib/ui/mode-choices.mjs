export const MODE_INTRO = 'Режим сессии: можно ли менять файлы и инфраструктуру.';

export const MODE_CHOICES = [
  { value: 'build', label: 'BUILD', description: 'можно менять файлы и выполнять команды.' },
  { value: 'plan', label: 'PLAN', description: 'чтение, безопасные команды и план. Писать можно только в .devops/plans и .devops/drafts.' },
  { value: 'ask', label: 'ASK', description: 'только ответы. Запись файлов выключена, команды только из списка чтения.' },
];
