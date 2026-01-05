import { parseNotes } from './linkParser';

describe('linkParser', () => {
  describe('parseNotes', () => {
    describe('URL trailing punctuation handling', () => {
      it('should strip trailing period from https URL', () => {
        const result = parseNotes('Check out https://example.com.');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'https://example.com',
          displayText: 'https://example.com',
          url: 'https://example.com',
          isFilePath: false,
        });
        // The period should remain as a text segment
        const lastSegment = result[result.length - 1];
        expect(lastSegment).toEqual({type: 'text', content: '.'});
      });

      it('should strip trailing comma from https URL', () => {
        const result = parseNotes('Visit https://example.com, then continue.');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'https://example.com',
          displayText: 'https://example.com',
          url: 'https://example.com',
          isFilePath: false,
        });
      });

      it('should strip trailing punctuation from www URL', () => {
        const result = parseNotes('Go to www.example.com!');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'www.example.com',
          displayText: 'www.example.com',
          url: 'www.example.com',
          isFilePath: false,
        });
        // The exclamation mark should remain as a text segment
        const lastSegment = result[result.length - 1];
        expect(lastSegment).toEqual({type: 'text', content: '!'});
      });

      it('should strip multiple trailing punctuation characters', () => {
        const result = parseNotes('See https://example.com/path?query=1).');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'https://example.com/path?query=1',
          displayText: 'https://example.com/path?query=1',
          url: 'https://example.com/path?query=1',
          isFilePath: false,
        });
      });

      it('should strip trailing quotes from URL', () => {
        const result = parseNotes('Link: "https://example.com"');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'https://example.com',
          displayText: 'https://example.com',
          url: 'https://example.com',
          isFilePath: false,
        });
      });

      it('should preserve URL without trailing punctuation', () => {
        const result = parseNotes('Visit https://example.com/page');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'https://example.com/page',
          displayText: 'https://example.com/page',
          url: 'https://example.com/page',
          isFilePath: false,
        });
      });

      it('should handle URL at end of sentence with semicolon', () => {
        const result = parseNotes('First link: https://example.com;');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'https://example.com',
          displayText: 'https://example.com',
          url: 'https://example.com',
          isFilePath: false,
        });
      });

      it('should handle URL followed by closing bracket', () => {
        const result = parseNotes('(see https://example.com)');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'https://example.com',
          displayText: 'https://example.com',
          url: 'https://example.com',
          isFilePath: false,
        });
        // The closing paren should remain as a text segment
        const lastSegment = result[result.length - 1];
        expect(lastSegment).toEqual({type: 'text', content: ')'});
      });
    });
    describe('raw file paths and tags handling', () => {
      it('should handle file path with # in it', () => {
        const result = parseNotes('check D:/my/path/file_##.pdf');
        const linkSegment = result.find(s => s.type === 'link');
        expect(linkSegment).toEqual({
          type: 'link',
          content: 'D:/my/path/file_##.pdf',
          displayText: 'D:/my/path/file_##.pdf',
          url: 'D:/my/path/file_##.pdf',
          isFilePath: true
        })
      });

      it('should find file paths on notes edges or inbetween spaces', () => {
        const result = parseNotes('D:/my/path/file_1.pdf D:/my/path/file_2.pdf D:/my/path/file_3.pdf');
        const linkSegment = result.filter(s => s.type === 'link');
        expect(linkSegment?.length).toEqual(3);
      });

      it('should find windows file paths with forward or backslashes', () => {
        const result = parseNotes('D:\\my\\path\\file_1.pdf D:\\my\\path\\file_2.pdf D:\\my\\path\\file_3.pdf');
        const linkSegment = result.filter(s => s.type === 'link');
        expect(linkSegment?.length).toEqual(3);
      });

      it('should not create tag with ##', () => {
        const result = parseNotes('#tag ##notatag');
        const linkSegment = result.filter(s => s.type === 'tag');
        expect(linkSegment?.length).toEqual(1);
      });

      it('should not create tag with #()', () => {
        const result = parseNotes('#tag #()notatag');
        const linkSegment = result.filter(s => s.type === 'tag');
        expect(linkSegment?.length).toEqual(1);
      });

      it('extracts comment from #tag(comment here)', () => {
        const result = parseNotes('#tag(comment here)');
        const linkSegment = result.find(s => s.type === 'tag');
        expect(linkSegment?.comment).toEqual(
          "comment here"
        );
      });

      it('extracts comment from #tag( comment here ) with spaces in between parenthesis', () => {
        const result = parseNotes('#tag( comment here )');
        const linkSegment = result.find(s => s.type === 'tag');
        expect(linkSegment?.comment).toEqual(
          " comment here "
        );
      });

      it('should not create tag inside of another tag comment', () => {
        const result = parseNotes('#tag(comment with #another_tag)');
        const linkSegment = result.filter(s => s.type === 'tag');
        expect(linkSegment?.length).toEqual(1);
      });
    });
  });
});
