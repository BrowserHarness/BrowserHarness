import type { ReactNode } from "react";
import { Box, Button, Divider, Stack, Typography } from "@mui/material";
import { MoreDetails, PageTitle, SettingsCard } from "../kit";
import type { SectionId, SectionProps } from "./SettingsShell";

interface Question {
  q: string;
  a: ReactNode;
  link?: { to: SectionId; label: string };
}

const QUESTIONS: Question[] = [
  {
    q: "What is BrowserHarness?",
    a: "A helper inside Chrome. You ask for something in plain words, and it reads web pages, clicks and types for you, then tells you what it found or did."
  },
  {
    q: "How do I give it a task?",
    a: "Click the BrowserHarness icon at the top right of Chrome to open the side panel. Type what you want in the box at the bottom, the way you would ask a person, and press Enter."
  },
  {
    q: "Will it buy things or send messages without asking me?",
    a: "Not with the normal setting. It stops and asks before it sends, submits, buys or deletes anything, and always before paying or changing a password, unless you allowed a website to skip asking.",
    link: { to: "safety", label: "Check your safety choice" }
  },
  {
    q: "How do I stop it right now?",
    a: "Press the stop button at the top of the side panel, next to the model name. It appears while a task is running."
  },
  {
    q: "What does it cost?",
    a: "BrowserHarness itself is free. The AI you connect may charge for what you use (for example OpenRouter or OpenAI). An AI running on your own computer is free."
  },
  {
    q: "It says no AI is connected. What do I do?",
    a: "Open Your AI and press Connect next to OpenRouter, or pick an AI on this computer. It checks the AI works before saving it.",
    link: { to: "ai", label: "Open Your AI" }
  },
  {
    q: "A task went wrong or got stuck.",
    a: "Press stop, then ask again in a different way, with more detail: the website, what to look for, and what you want back. Small AI models struggle with long tasks, so a bigger model can help."
  },
  {
    q: "Can it use websites I'm signed in to?",
    a: "Yes. It works in your own Chrome, so it can use the websites you are already signed in to. It asks you before changing a password or account security."
  },
  {
    q: "What is a Skill?",
    a: "A task BrowserHarness learned and can repeat, like “find red shoes in my size”. Run one by typing / and its name in the chat.",
    link: { to: "skills", label: "See your Skills" }
  },
  {
    q: "Can I use it from my phone?",
    a: "Yes, through your own private bot in Telegram, Discord, Slack, Signal or email. It needs the free helper app on this computer.",
    link: { to: "phone", label: "Set up phone & chat apps" }
  },
  {
    q: "The words are too small.",
    a: "Choose Large or Extra large under Look & text size.",
    link: { to: "look", label: "Make text bigger" }
  },
  {
    q: "Where is my information kept?",
    a: "On this computer, inside Chrome. Your requests and the pages it reads go to the AI you connected, so it can work.",
    link: { to: "privacy", label: "Privacy & your data" }
  }
];

export function HelpPage({ go }: SectionProps) {
  const version = chrome.runtime.getManifest?.().version;
  return (
    <>
      <PageTitle title="Help" intro="Simple answers to common questions. Press a question to see the answer." />
      <Stack spacing={2.5}>
        <SettingsCard>
          <Stack spacing={0.5} divider={<Divider flexItem />}>
            {QUESTIONS.map((item) => (
              <Box key={item.q} py={0.5}>
                <MoreDetails summary={item.q}>
                  <Typography variant="body2" pb={item.link ? 0.5 : 1}>
                    {item.a}
                  </Typography>
                  {item.link && (
                    <Button size="small" variant="outlined" sx={{ mb: 1 }} onClick={() => go(item.link!.to)}>
                      {item.link.label}
                    </Button>
                  )}
                </MoreDetails>
              </Box>
            ))}
          </Stack>
        </SettingsCard>
        <SettingsCard title="For someone helping you">
          <Typography variant="body2">
            BrowserHarness version {version || "unknown"}. The full guides are in the docs folder that came with the
            download.
          </Typography>
        </SettingsCard>
      </Stack>
    </>
  );
}
