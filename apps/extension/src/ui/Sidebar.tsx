// The menu down the side, like Claude and ChatGPT: which Space you are in,
// a button for a new chat, your saved chats (search, rename, pin, save as a
// file, delete) and the other screens. In the full-page chat it stays open;
// in the narrow side panel it slides in from the left.
import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Divider,
  IconButton,
  InputBase,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  ListSubheader,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography
} from "@mui/material";
import {
  AddIcon,
  CheckIcon,
  ChevronDownIcon,
  CloseIcon,
  DeleteIcon,
  EditIcon,
  FullPageIcon,
  HistoryIcon,
  MemoryIcon,
  MoreIcon,
  NewChatIcon,
  PinIcon,
  SaveFileIcon,
  SearchIcon,
  SettingsIcon,
  SkillsIcon,
  SpacesIcon,
  UnpinIcon
} from "./icons";
import {
  chatFileName,
  chatGroup,
  chatToMarkdown,
  chatToText,
  deleteChat,
  loadChats,
  renameChat,
  searchChats,
  setChatPinned,
  type SavedChat
} from "../runtime/chats";
import { createSpace, isKeyFor, SPACE_SCOPED_KEYS, switchSpace, type Space } from "../runtime/spaces";
import { useConfirm } from "./kit";
import { useSaved } from "./feedback";
import { NameDialog, saveTextFile, SpaceBadge } from "./spaces-ui";

export type SidebarScreen = "skills" | "memory" | "history" | "settings";

export function Sidebar({
  spaces,
  active,
  currentChatId,
  busy,
  fullPage,
  onNewChat,
  onOpenChat,
  onChatDeleted,
  onScreen,
  onManageSpaces,
  onOpenFullPage,
  onClose
}: {
  spaces: Space[];
  active: Space;
  currentChatId: string;
  /** A task is running: switching Space or chat waits until it ends. */
  busy: boolean;
  fullPage: boolean;
  onNewChat: () => void;
  onOpenChat: (chat: SavedChat) => void;
  onChatDeleted: (id: string) => void;
  onScreen: (screen: SidebarScreen) => void;
  onManageSpaces: () => void;
  onOpenFullPage?: () => void;
  onClose?: () => void;
}) {
  const [chats, setChats] = useState<SavedChat[]>([]);
  const [query, setQuery] = useState("");
  const [spaceMenu, setSpaceMenu] = useState<HTMLElement | null>(null);
  const [chatMenu, setChatMenu] = useState<{ anchor: HTMLElement; chat: SavedChat } | null>(null);
  const [renaming, setRenaming] = useState<SavedChat | null>(null);
  const [newSpace, setNewSpace] = useState(false);
  const [spaceError, setSpaceError] = useState("");
  const [dialog, confirm] = useConfirm();
  const saved = useSaved();

  useEffect(() => {
    const load = () => void loadChats().then(setChats).catch(() => undefined);
    load();
    const onChange = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && Object.keys(changes).some((key) => isKeyFor(key, SPACE_SCOPED_KEYS.chats))) load();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [active.id]);

  const shown = useMemo(() => searchChats(chats, query), [chats, query]);
  const groups = useMemo(() => {
    const out: { label: string; chats: SavedChat[] }[] = [];
    for (const chat of shown) {
      const label = query ? "Found" : chat.pinned ? "Pinned" : chatGroup(chat.updated_at);
      const group = out.find((item) => item.label === label);
      if (group) group.chats.push(chat);
      else out.push({ label, chats: [chat] });
    }
    return out;
  }, [shown, query]);

  const saveAs = (chat: SavedChat, kind: "md" | "txt") => {
    const text = kind === "md" ? chatToMarkdown(chat, active.name) : chatToText(chat, active.name);
    saveTextFile(text, chatFileName(chat.title, kind), kind === "md" ? "text/markdown" : "text/plain");
    saved("Chat saved to your Downloads folder");
  };

  const remove = async (chat: SavedChat) => {
    const ok = await confirm({
      title: "Delete this chat?",
      body: `“${chat.title}” is deleted from ${active.name}. This can't be undone. Tip: save it as a file first if you want to keep a copy.`,
      confirmLabel: "Delete chat",
      danger: true
    });
    if (!ok) return;
    await deleteChat(chat.id);
    onChatDeleted(chat.id);
    saved("Chat deleted");
  };

  const busyNote = "Wait for the current task to finish, or press Stop";

  return (
    <Box
      component="nav"
      aria-label="Chats and Spaces"
      sx={{ height: "100%", display: "flex", flexDirection: "column", bgcolor: "background.paper", minWidth: 0 }}
    >
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ px: 1.25, pt: 1.25, pb: 0.5 }}>
        <Tooltip title={busy ? busyNote : "Switch Space"}>
          <span style={{ flex: 1, minWidth: 0 }}>
            <Button
              fullWidth
              color="inherit"
              disabled={busy}
              onClick={(event) => setSpaceMenu(event.currentTarget)}
              aria-label={`Space: ${active.name}. Switch Space`}
              data-testid="space-switcher"
              sx={{ justifyContent: "flex-start", gap: 1, px: 1, py: 0.75, borderRadius: 2, textTransform: "none", minWidth: 0 }}
            >
              <SpaceBadge space={active} size={26} />
              <Box sx={{ minWidth: 0, flex: 1, textAlign: "left" }}>
                <Typography variant="caption" color="text.secondary" component="div" lineHeight={1.1}>
                  Space
                </Typography>
                <Typography variant="subtitle2" noWrap component="div" lineHeight={1.3}>
                  {active.name}
                </Typography>
              </Box>
              <ChevronDownIcon fontSize="small" />
            </Button>
          </span>
        </Tooltip>
        {onClose && (
          <Tooltip title="Close the menu">
            <IconButton onClick={onClose} aria-label="Close the menu">
              <CloseIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        )}
      </Stack>

      <Box sx={{ px: 1.25, pb: 1 }}>
        <Tooltip title={busy ? busyNote : "Start a fresh chat in this Space"}>
          <span>
            <Button
              fullWidth
              variant="outlined"
              startIcon={<NewChatIcon fontSize="small" />}
              onClick={onNewChat}
              disabled={busy}
              sx={{ justifyContent: "flex-start", borderRadius: 2, py: 0.9 }}
            >
              New chat
            </Button>
          </span>
        </Tooltip>
        {chats.length > 0 && (
          <Stack
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ mt: 1, px: 1.25, py: 0.5, borderRadius: 2, bgcolor: "action.hover", color: "text.secondary" }}
          >
            <SearchIcon fontSize="small" />
            <InputBase
              fullWidth
              placeholder="Search your chats"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              inputProps={{ "aria-label": "Search your chats" }}
              sx={{ fontSize: "0.9rem" }}
            />
          </Stack>
        )}
      </Box>

      <Box sx={{ flex: 1, overflowY: "auto", px: 0.5 }} data-testid="chat-list">
        {chats.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1.5 }}>
            Your chats in {active.name} will be listed here, so you can come back to them any time.
          </Typography>
        ) : shown.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, py: 1.5 }}>
            No chat in {active.name} has those words.
          </Typography>
        ) : (
          <List dense disablePadding>
            {groups.map((group) => (
              <Box key={group.label} component="li" sx={{ listStyle: "none" }}>
                <ListSubheader disableSticky sx={{ bgcolor: "transparent", lineHeight: 2.2, fontSize: "0.75rem", fontWeight: 600 }}>
                  {group.label}
                </ListSubheader>
                <Box component="ul" sx={{ p: 0, m: 0 }}>
                  {group.chats.map((chat) => (
                    <ListItem
                      key={chat.id}
                      disablePadding
                      sx={{ "& .chat-more": { opacity: { md: 0 } }, "&:hover .chat-more, & .chat-more:focus-visible, & .chat-more[aria-expanded]": { opacity: 1 } }}
                      secondaryAction={
                        <IconButton
                          className="chat-more"
                          size="small"
                          edge="end"
                          aria-label={`More for ${chat.title}`}
                          onClick={(event) => setChatMenu({ anchor: event.currentTarget, chat })}
                        >
                          <MoreIcon fontSize="small" />
                        </IconButton>
                      }
                    >
                      <ListItemButton
                        selected={chat.id === currentChatId}
                        disabled={busy && chat.id !== currentChatId}
                        onClick={() => onOpenChat(chat)}
                        sx={{ borderRadius: 2, mx: 0.5, py: 0.5, pr: "40px !important" }}
                      >
                        <ListItemText primary={chat.title} slotProps={{ primary: { noWrap: true, fontSize: "0.9rem" } }} />
                        {chat.pinned && (
                          <Box sx={{ color: "text.secondary", display: "inline-flex" }} aria-label="Pinned">
                            <PinIcon fontSize="small" />
                          </Box>
                        )}
                      </ListItemButton>
                    </ListItem>
                  ))}
                </Box>
              </Box>
            ))}
          </List>
        )}
      </Box>

      <Divider />
      <List dense sx={{ px: 0.5, py: 0.5 }}>
        {(
          [
            { id: "skills", label: "Skills", icon: SkillsIcon },
            { id: "memory", label: "About me", icon: MemoryIcon },
            { id: "history", label: "Task history", icon: HistoryIcon },
            { id: "settings", label: "Settings", icon: SettingsIcon }
          ] as const
        ).map((item) => (
          <ListItemButton key={item.id} onClick={() => onScreen(item.id)} sx={{ borderRadius: 2, mx: 0.5 }}>
            <ListItemIcon sx={{ minWidth: 34 }}>
              <item.icon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary={item.label} />
          </ListItemButton>
        ))}
        {!fullPage && onOpenFullPage && (
          <ListItemButton onClick={onOpenFullPage} sx={{ borderRadius: 2, mx: 0.5 }}>
            <ListItemIcon sx={{ minWidth: 34 }}>
              <FullPageIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Open as a full page" />
          </ListItemButton>
        )}
      </List>

      <Menu anchorEl={spaceMenu} open={Boolean(spaceMenu)} onClose={() => setSpaceMenu(null)} slotProps={{ paper: { sx: { minWidth: 240 } } }}>
        <Typography variant="caption" color="text.secondary" sx={{ px: 2, py: 0.5, display: "block" }}>
          Each Space keeps its own chats and notes about you
        </Typography>
        {spaces.map((space) => (
          <MenuItem
            key={space.id}
            selected={space.id === active.id}
            onClick={() => {
              setSpaceMenu(null);
              if (space.id !== active.id) {
                void switchSpace(space.id).then(() => saved(`Switched to ${space.name}`));
              }
            }}
          >
            <ListItemIcon>
              <SpaceBadge space={space} />
            </ListItemIcon>
            <ListItemText primary={space.name} />
            {space.id === active.id && <CheckIcon fontSize="small" />}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => {
            setSpaceMenu(null);
            setSpaceError("");
            setNewSpace(true);
          }}
        >
          <ListItemIcon>
            <AddIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="New Space" />
        </MenuItem>
        <MenuItem
          onClick={() => {
            setSpaceMenu(null);
            onManageSpaces();
          }}
        >
          <ListItemIcon>
            <SpacesIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Manage Spaces" />
        </MenuItem>
      </Menu>

      <Menu anchorEl={chatMenu?.anchor} open={Boolean(chatMenu)} onClose={() => setChatMenu(null)}>
        {chatMenu && [
          <MenuItem
            key="rename"
            onClick={() => {
              setRenaming(chatMenu.chat);
              setChatMenu(null);
            }}
          >
            <ListItemIcon>
              <EditIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Rename" />
          </MenuItem>,
          <MenuItem
            key="pin"
            onClick={() => {
              const { chat } = chatMenu;
              setChatMenu(null);
              void setChatPinned(chat.id, !chat.pinned).then(() => saved(chat.pinned ? "Unpinned" : "Pinned to the top"));
            }}
          >
            <ListItemIcon>{chatMenu.chat.pinned ? <UnpinIcon fontSize="small" /> : <PinIcon fontSize="small" />}</ListItemIcon>
            <ListItemText primary={chatMenu.chat.pinned ? "Unpin" : "Pin to the top"} />
          </MenuItem>,
          <MenuItem
            key="md"
            onClick={() => {
              saveAs(chatMenu.chat, "md");
              setChatMenu(null);
            }}
          >
            <ListItemIcon>
              <SaveFileIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Save as a document" secondary="Keeps headings and lists; opens in notes apps and Google Docs" />
          </MenuItem>,
          <MenuItem
            key="txt"
            onClick={() => {
              saveAs(chatMenu.chat, "txt");
              setChatMenu(null);
            }}
          >
            <ListItemIcon>
              <SaveFileIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Save as plain text" secondary="Opens anywhere" />
          </MenuItem>,
          <Divider key="divider" />,
          <MenuItem
            key="delete"
            onClick={() => {
              const { chat } = chatMenu;
              setChatMenu(null);
              void remove(chat);
            }}
            sx={{ color: "error.main" }}
          >
            <ListItemIcon sx={{ color: "inherit" }}>
              <DeleteIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="Delete" />
          </MenuItem>
        ]}
      </Menu>

      <NameDialog
        open={Boolean(renaming)}
        title="Rename this chat"
        label="Chat name"
        initial={renaming?.title}
        confirmLabel="Save name"
        onClose={() => setRenaming(null)}
        onSave={(value) => {
          const chat = renaming;
          setRenaming(null);
          if (chat) void renameChat(chat.id, value).then(() => saved("Chat renamed"));
        }}
      />
      <NameDialog
        open={newSpace}
        title="Make a new Space"
        intro="A Space keeps one part of your life separate, with its own chats and its own notes about you. For example: Work, Home, or Family trip."
        label="Name of the Space"
        placeholder="For example: Work"
        confirmLabel="Make Space"
        error={spaceError}
        onClose={() => setNewSpace(false)}
        onSave={(value) => {
          void createSpace(value).then((result) => {
            if (!result.ok) {
              setSpaceError(result.error);
              return;
            }
            setNewSpace(false);
            saved(`${result.space.name} is ready. You're in it now`);
            // A new Space has no chats yet: go straight to the chat box.
            onClose?.();
          });
        }}
      />
      {dialog}
    </Box>
  );
}
