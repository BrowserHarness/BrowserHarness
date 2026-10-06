// A tiny IMAP + SMTP server on this computer for tests (plain TCP, loopback only).
import net from "node:net";

/** A tiny IMAP + SMTP server on this computer, enough for the bot. */
export async function fakeMailServers(inbox) {
  const sent = [];
  const logins = [];
  const imap = net.createServer((socket) => {
    socket.write("* OK fake IMAP ready\r\n");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const [tag, ...rest] = line.split(" ");
        const command = rest.join(" ");
        if (/^LOGIN/i.test(command)) {
          logins.push(command);
          socket.write(command.includes('"secret"') ? `${tag} OK logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
        } else if (/^SELECT/i.test(command)) {
          socket.write(`* ${inbox.length} EXISTS\r\n* OK [UIDNEXT ${inbox.uidNext}] next\r\n${tag} OK [READ-WRITE] done\r\n`);
        } else if (/^UID SEARCH UNSEEN/i.test(command)) {
          socket.write(`* SEARCH ${inbox.filter((item) => !item.seen).map((item) => item.uid).join(" ")}\r\n${tag} OK done\r\n`);
        } else if (/^UID FETCH (\d+)/i.test(command)) {
          const item = inbox.find((candidate) => candidate.uid === Number(/^UID FETCH (\d+)/i.exec(command)[1]));
          const bytes = Buffer.from(item.raw);
          socket.write(`* 1 FETCH (UID ${item.uid} BODY[] {${bytes.length}}\r\n`);
          socket.write(bytes);
          socket.write(` FLAGS ())\r\n${tag} OK done\r\n`);
        } else if (/^UID STORE (\d+)/i.test(command)) {
          inbox.find((candidate) => candidate.uid === Number(/^UID STORE (\d+)/i.exec(command)[1])).seen = true;
          socket.write(`${tag} OK done\r\n`);
        } else {
          socket.write(`${tag} OK bye\r\n`);
        }
      }
    });
  });
  const smtp = net.createServer((socket) => {
    socket.write("220 fake SMTP\r\n");
    let buffer = "";
    let data = null;
    let current = {};
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data !== null) {
          if (line === ".") {
            sent.push({ ...current, data });
            data = null;
            socket.write("250 queued\r\n");
          } else data += `${line}\n`;
        } else if (/^EHLO/i.test(line)) socket.write("250-fake\r\n250 AUTH PLAIN\r\n");
        else if (/^AUTH PLAIN/i.test(line)) socket.write(Buffer.from(line.slice(11), "base64").toString().endsWith("secret") ? "235 ok\r\n" : "535 no\r\n");
        else if (/^MAIL FROM/i.test(line)) socket.write("250 ok\r\n");
        else if (/^RCPT TO:<(.+)>/i.test(line)) {
          current = { to: /^RCPT TO:<(.+)>/i.exec(line)[1] };
          socket.write("250 ok\r\n");
        } else if (/^DATA/i.test(line)) {
          data = "";
          socket.write("354 go\r\n");
        } else if (/^QUIT/i.test(line)) {
          socket.write("221 bye\r\n");
          socket.end();
        }
      }
    });
  });
  await Promise.all([new Promise((resolve) => imap.listen(0, "127.0.0.1", resolve)), new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve))]);
  return {
    sent,
    logins,
    imap: { host: "127.0.0.1", port: imap.address().port, secure: false },
    smtp: { host: "127.0.0.1", port: smtp.address().port, secure: false },
    close: () => {
      imap.close();
      smtp.close();
    }
  };
}

