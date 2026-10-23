package pl.d33.wiktionary;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Minimal HTTP/1.1 server for unit tests (the Android unit test classpath has
 * no com.sun.net.httpserver): one request per connection, then close.
 */
final class TinyHttpServer implements AutoCloseable {
    static final class Request {
        final String path;
        final Map<String, String> headers;

        Request(String path, Map<String, String> headers) {
            this.path = path;
            this.headers = headers;
        }
    }

    static final class Response {
        final int status;
        final Map<String, String> headers = new HashMap<>();
        final byte[] body;

        Response(int status, byte[] body) {
            this.status = status;
            this.body = body;
        }

        Response header(String name, String value) {
            headers.put(name, value);
            return this;
        }
    }

    interface Handler {
        Response handle(Request request);
    }

    private final ServerSocket socket;
    private final Thread thread;

    TinyHttpServer(Handler handler) throws IOException {
        socket = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
        thread = new Thread(() -> {
            while (!socket.isClosed()) {
                try (Socket client = socket.accept()) {
                    serve(client, handler);
                } catch (IOException e) {
                    // Closed by close(), or a client hung up: keep serving or stop.
                }
            }
        });
        thread.setDaemon(true);
        thread.start();
    }

    int port() {
        return socket.getLocalPort();
    }

    private static void serve(Socket client, Handler handler) throws IOException {
        BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.ISO_8859_1));
        String requestLine = in.readLine();
        if (requestLine == null) return;
        Map<String, String> headers = new HashMap<>();
        for (String line = in.readLine(); line != null && !line.isEmpty(); line = in.readLine()) {
            int colon = line.indexOf(':');
            if (colon > 0) headers.put(line.substring(0, colon).trim().toLowerCase(Locale.ROOT), line.substring(colon + 1).trim());
        }
        String path = requestLine.split(" ")[1];
        Response r = handler.handle(new Request(path, headers));
        StringBuilder head = new StringBuilder("HTTP/1.1 " + r.status + " X\r\n");
        for (Map.Entry<String, String> h : r.headers.entrySet()) head.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
        head.append("Content-Length: ").append(r.body.length).append("\r\nConnection: close\r\n\r\n");
        OutputStream out = client.getOutputStream();
        out.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.write(r.body);
        out.flush();
    }

    @Override
    public void close() throws IOException {
        socket.close();
    }
}
