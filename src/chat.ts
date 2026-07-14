import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { getAnthropic, buildSystemPrompt } from './brain';
import { MODEL } from './config';
import { logSession, type Turn } from './log';

const EXIT_WORDS = ['çık', 'cik', 'exit', 'quit', 'q'];

async function main(): Promise<void> {
  const anthropic = getAnthropic();
  const messages: Turn[] = [];

  const rl = readline.createInterface({ input: stdin, output: stdout });
  console.log('AI İkiz hazır. Müşteri gibi yaz, ikiz cevaplasın. Çıkmak için "çık".\n');

  while (true) {
    const user = (await rl.question('Müşteri > ')).trim();
    if (!user) continue;
    if (EXIT_WORDS.includes(user.toLowerCase())) break;

    messages.push({ role: 'user', content: user });
    stdout.write('İkiz    > ');

    // Sistem promptunu her turda güncel mesaja göre kur (RAG): örnekler bu
    // müşteri mesajına en uygun konuşmalardan seçilir.
    const system = await buildSystemPrompt(user);
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system,
      messages,
    });
    stream.on('text', (delta) => stdout.write(delta));
    const final = await stream.finalMessage();
    stdout.write('\n\n');

    const text = final.content
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');
    messages.push({ role: 'assistant', content: text });
  }

  rl.close();
  await logSession(messages);
  console.log('\nGörüşme kaydedildi. Görüşürüz!');
}

main().catch((e) => {
  console.error('\nHata:', e?.message ?? e);
  process.exit(1);
});
