# Pinterest keywords (researched Oct 25, 2026)

Where they come from: Pinterest's own search suggestions (its autocomplete, ranked by what people search) and Google's
autocomplete, for the phrases a parent of a new reader would start typing. Not guesses. Re-run the queries (bottom) when
the series grows.

## What matches us (use these)

From Pinterest's suggestions:
- early chapter books for kids, early chapter books for first grade, best early chapter books, early reader chapter books for kids
- chapter books for beginning readers, books for beginning readers, best books for beginning readers
- dragon chapter books for kids, kids dragon books
- chapter books for first graders, easy chapter books for first grade, first grade chapter books
- decodable stories, decodable readers, decodable books, decodable readers kindergarten
- books for reluctant readers, chapter books for reluctant readers
- reading books for kindergarten, first reading books kindergarten

From Google's suggestions:
- books for 6 year olds to read themselves (our promise, word for word)
- early chapter books like dragon masters, books for kids who like dragon masters
- books for kindergarteners to read on their own
- first chapter books for 6 year olds, fantasy books for 6 year olds
- books for kids to read online free, first grade reading books online free

## What to avoid or use carefully
- "first chapter books" on Pinterest leans to read-alouds (first chapter books to read aloud, best read alouds for first grade):
  parents reading to kids. We're the opposite, so "early chapter books" and "beginning readers" fit better.
- "decodable" and "sight words" are big but mostly worksheets and printables (decodable passages, sight words worksheets).
  Use them in descriptions for search, never as the headline (the positioning: lead with the story).
- Pinterest is printable-heavy ("free printable books for beginning readers pdf"): a printable chapter is a likely winner later.

## Where they go
Pin titles (100 characters), descriptions (800), alt text (500) and board names and descriptions. The API has no tag field.
Boards: "Julia and Toby: early chapter books" and "Dragon chapter books for kids".

## The queries
Pinterest: `https://www.pinterest.com/resource/AdvancedTypeaheadResource/get/?source_url=/&data={"options":{"term":"<seed>","pin_scope":"pins","count":10}}`
with a browser user agent and `X-Requested-With: XMLHttpRequest`, `X-Pinterest-PWS-Handler: www/index.js`.
Google: `https://suggestqueries.google.com/complete/search?client=firefox&q=<seed>`.
Seeds used: first chapter books, early chapter books, books for 6 year olds, dragon books for kids, books like dragon masters,
beginning readers, decodable, kindergarten reading books, first grade reading, reluctant readers, learn to read, sight words,
books for kids who, dragon books for, beginning reader books, books for kindergarteners to read, decodable books,
reluctant reader books, fantasy books for 6, first grade reading books, read alone books, phonics books for.
