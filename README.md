This is the 2026 implementation via ChatGPT of an attempt to visualize the internet as a grid organized around IP numbers.
It is inspired by an earlier 1996 implementation via DikuMUD open-source software creating a text-based version of the same idea.

## Supabase Storage

Custom multiplayer avatars use Supabase Storage. Deployment needs a public bucket named `avatars`; uploaded `.glb` files are stored under stable per-user paths and referenced by public URL in presence.
